/**
 * The execution engine.
 *
 * Reads a declarative workflow, walks the DAG in a stable topological order,
 * asks the binding engine who should do each unit of work, calls providers
 * through the cache, and commits results to the World under declared merge
 * semantics.
 *
 * Two properties this engine deliberately has:
 *
 *   1. Node writes are committed atomically, after the join policy resolves.
 *      That is what makes `join: best_of(2)` expressible at all, and it means
 *      a failed fan-out cannot leave half-written state behind.
 *
 *   2. Failure recovery is a *re-binding*, not a retry loop in application
 *      code: a failed model is excluded and the policy is re-resolved, so the
 *      documented `fallback:` / `escalate_if:` chain is the only recovery path.
 */

import type {
  AgentSpec,
  CandidateReport,
  CompletionRequest,
  Contract,
  ModelProfile,
  NodeRunRecord,
  NodeSpec,
  RunMeta,
  WorkflowSpec,
} from '../schema/types.ts';
import type { ProviderRegistry } from '../providers/index.ts';
import type { Prefer } from './binding.ts';

import { BindingError, makeFamilyResolver, resolveBinding } from './binding.ts';
import { CallCache, hashCall } from './cache.ts';
import { evalGuard, resolveInputs, resolveRef } from './refs.ts';
import type { EvalContext, NodeView } from './refs.ts';
import { Chronicle, RunStore } from './trace.ts';
import type { RunHandle } from './trace.ts';
import { World } from './world.ts';

export interface EngineDeps {
  workflow: WorkflowSpec;
  agents: Map<string, AgentSpec>;
  models: ModelProfile[];
  providers: ProviderRegistry;
  cache: CallCache;
  runStore: RunStore;
  log?: (line: string) => void;
  /** Interactive gate handler. Defaults to auto-approve. */
  onHumanGate?: (node: NodeSpec, inputs: Record<string, unknown>) => Promise<boolean>;
  /** Preview mode: no provider calls at all. */
  dryRun?: boolean;
  /** Ignore the call cache (forces live calls). */
  fresh?: boolean;
  allowUnavailableProviders?: boolean;
  maxParallelDefault?: number;
  temperature?: number;
}

export interface RunOptions {
  input: Record<string, unknown>;
  /** nodeId -> model glob, overriding the node's bind policy. */
  swaps?: Record<string, string>;
  replayOf?: string;
  runId?: string;
}

export interface RunResult {
  meta: RunMeta;
  world: Record<string, unknown>;
  chronicle: Chronicle;
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

interface ItemResult {
  index: number;
  ok: boolean;
  model?: ModelProfile;
  output?: Record<string, unknown>;
  record: NodeRunRecord;
}

interface PendingWrite {
  field: string;
  value: unknown;
  item: number;
}

export async function runWorkflow(deps: EngineDeps, opts: RunOptions): Promise<RunResult> {
  const { workflow, agents, models, providers, cache, runStore } = deps;
  const log = deps.log ?? (() => {});
  const swaps = opts.swaps ?? {};
  const dryRun = deps.dryRun ?? false;
  const allowUnavailable = deps.allowUnavailableProviders ?? dryRun;
  const maxParallelDefault = deps.maxParallelDefault ?? 4;
  const temperature = deps.temperature ?? 0;

  const runId = opts.runId ?? runStore.newRunId(workflow.name);
  const handle: RunHandle = runStore.create(runId);
  const chronicle = new Chronicle(runId);

  const world = new World(workflow.world);
  const nodeViews = new Map<string, NodeView>();
  const records: NodeRunRecord[] = [];
  const bindings: Record<string, string> = {};

  let totalCost = 0;
  let totalTokens = { in: 0, out: 0 };
  let status: RunMeta['status'] = 'ok';
  let failure: string | undefined;

  chronicle.record('run.start', {
    workflow: workflow.name,
    runId,
    dryRun,
    input: opts.input,
    ...(opts.replayOf ? { replayOf: opts.replayOf } : {}),
    ...(Object.keys(swaps).length ? { swaps } : {}),
  });

  const order = topoOrder(workflow.nodes);
  const evalCtxBase = { input: opts.input, world, nodes: nodeViews };

  try {
    for (const node of order) {
      // ---- guard -----------------------------------------------------------
      if (node.when) {
        const ctx: EvalContext = { ...evalCtxBase };
        let pass: boolean;
        try {
          pass = evalGuard(node.when, ctx);
        } catch (err) {
          throw new Error(`node "${node.id}" guard \`${node.when}\` failed: ${(err as Error).message}`);
        }
        if (!pass) {
          log(`  ${pad(node.id)} ⤵  skipped  (when: ${node.when})`);
          chronicle.record('node.skip', { when: node.when, reason: 'guard evaluated false' }, { node: node.id });
          nodeViews.set(node.id, { status: 'skipped', cost_usd: 0 });
          records.push(emptyRecord(node.id, 'skipped'));
          continue;
        }
      }

      const ctx: EvalContext = { ...evalCtxBase };
      const inputs = resolveInputs(node.in, ctx);

      // ---- human gate ------------------------------------------------------
      if (node.kind === 'human_gate') {
        const approved = deps.onHumanGate
          ? await deps.onHumanGate(node, inputs)
          : true;
        chronicle.record('human.gate', { inputs, approved, auto: !deps.onHumanGate }, { node: node.id });
        log(`  ${pad(node.id)} ${approved ? '✔' : '✘'}  gate ${approved ? 'approved' : 'REJECTED'}`);
        const rec = emptyRecord(node.id, approved ? 'ok' : 'failed');
        rec.bindingSource = 'human_gate';
        if (!approved) {
          rec.error = 'human gate rejected';
          records.push(rec);
          nodeViews.set(node.id, { status: 'failed' });
          throw new Error(`run halted: human gate "${node.id}" was rejected`);
        }
        records.push(rec);
        nodeViews.set(node.id, { status: 'ok' });
        continue;
      }

      // ---- agent node ------------------------------------------------------
      const agent = agents.get(node.agent!);
      if (!agent) {
        throw new Error(
          `node "${node.id}" references unknown agent "${node.agent}". ` +
            `Available: ${[...agents.keys()].sort().join(', ')}`,
        );
      }

      const items = resolveItems(node, ctx);
      const maxParallel = node.budget?.maxParallel ?? maxParallelDefault;

      log(
        `  ${pad(node.id)} ▶  ${agent.name}` +
          (node.forEach ? `  for_each ${node.forEach} (${items.length} items)` : ''),
      );

      const itemResults = await mapLimit(items, maxParallel, (item, index) =>
        runItem({
          node,
          agent,
          index,
          item,
          total: items.length,
          ctx,
          deps,
          models,
          providers,
          cache,
          chronicle,
          swaps,
          dryRun,
          allowUnavailable,
          temperature,
        }),
      );

      // ---- join policy + atomic commit -------------------------------------
      const successes = itemResults.filter((r) => r.ok);

      let accepted: ItemResult[];
      try {
        accepted = applyJoin(node, itemResults, successes);
      } catch (err) {
        // Record the node before propagating: a run that fails should still
        // show which node failed, and why, in `syncw show` and `explain`.
        const failedRecord = mergeRecords(node.id, itemResults, []);
        failedRecord.status = 'failed';
        failedRecord.error = (err as Error).message;
        records.push(failedRecord);
        nodeViews.set(node.id, {
          status: 'failed',
          cost_usd: failedRecord.costUsd,
          actual_models: [],
          actual_families: [],
        });
        totalCost += failedRecord.costUsd;
        totalTokens = {
          in: totalTokens.in + failedRecord.tokens.in,
          out: totalTokens.out + failedRecord.tokens.out,
        };
        throw err;
      }

      const pending: PendingWrite[] = [];
      for (const r of accepted) {
        if (!r.output) continue;
        for (const [field, src] of Object.entries(node.out ?? {})) {
          const value = src === '$' ? r.output : r.output[src];
          if (value === undefined && src !== '$') {
            throw new Error(
              `node "${node.id}" maps world field "${field}" to contract field "${src}", ` +
                `but the agent's output has no such key. ` +
                `Contract declares: ${Object.keys(agent.out).join(', ')}`,
            );
          }
          pending.push({ field, value, item: r.index });
        }
      }

      if (!dryRun) {
        for (const w of pending) {
          const record = world.write(w.field, w.value, node.id);
          chronicle.record(
            'world.write',
            {
              field: w.field,
              strategy: record.strategy,
              item: w.item,
              ...(record.conflict ? { conflict: record.conflict } : {}),
            },
            { node: node.id, item: w.item },
          );
          if (record.conflict) log(`  ${pad(node.id)} ⚠  ${w.field}: ${record.conflict}`);
        }
      }

      // ---- accounting ------------------------------------------------------
      const rec = mergeRecords(node.id, itemResults, accepted);
      rec.output = accepted.length === 1 ? accepted[0]!.output : accepted.map((r) => r.output);
      records.push(rec);

      const usedModels = [...new Set(successes.map((r) => r.model!.id))];
      const usedFamilies = [...new Set(successes.map((r) => familyKey(r.model!, models)))];
      if (usedModels[0]) bindings[node.id] = usedModels.length === 1 ? usedModels[0] : usedModels.join(',');
      nodeViews.set(node.id, {
        ...(usedModels[0] ? { actual_model: usedModels[0] } : {}),
        ...(usedFamilies[0] ? { actual_family: usedFamilies[0] } : {}),
        // Always exposed as arrays, even for a single-model fan-out. A fan-out
        // that happened to land on one model is still a fan-out, and a
        // downstream `not_family_of: $.nodes.x.actual_families` must not break
        // just because the producer's heterogeneity collapsed. That asymmetry
        // is exactly the class of bug this project exists to prevent.
        actual_models: usedModels,
        actual_families: usedFamilies,
        status: rec.status,
        cost_usd: rec.costUsd,
        output: rec.output,
      });

      totalCost += rec.costUsd;
      totalTokens = { in: totalTokens.in + rec.tokens.in, out: totalTokens.out + rec.tokens.out };

      if (deps.log) {
        const bits = [`${usedModels.length ? usedModels.join('+') : 'n/a'}`, `$${rec.costUsd.toFixed(4)}`];
        if (rec.cacheHits) bits.push(`${rec.cacheHits}/${itemResults.length} cached`);
        if (rec.attempts > itemResults.length) bits.push(`${rec.attempts} attempts`);
        log(`  ${pad(node.id)} ${rec.status === 'ok' ? '✔' : '✘'}  ${bits.join('  ')}`);
      }

      if (workflow.budget?.maxUsd !== undefined && totalCost > workflow.budget.maxUsd) {
        throw new BudgetExceededError(
          `workflow budget exceeded after node "${node.id}": ` +
            `spent $${totalCost.toFixed(4)} of $${workflow.budget.maxUsd.toFixed(4)}`,
        );
      }
    }
  } catch (err) {
    const message = (err as Error).message;
    failure = message;
    status = err instanceof BudgetExceededError ? 'budget_exceeded' : 'failed';
    chronicle.record('run.end', { status, error: message });
    if (err instanceof BudgetExceededError) {
      chronicle.record('budget.exceeded', { message });
    }
  }

  const finishedAt = new Date().toISOString();
  if (status === 'ok') chronicle.record('run.end', { status, totalCostUsd: totalCost });

  const meta: RunMeta = {
    runId,
    workflow: workflow.name,
    startedAt: chronicle.events[0]?.ts ?? finishedAt,
    finishedAt,
    input: opts.input,
    nodes: records,
    totalCostUsd: round6(totalCost),
    totalTokens,
    bindings,
    status,
  };
  if (opts.replayOf) meta.replayOf = opts.replayOf;
  if (Object.keys(swaps).length) meta.swaps = swaps;
  if (failure) meta.error = failure;

  const snapshot = dryRun ? {} : world.snapshot();
  runStore.write(handle, chronicle, meta, snapshot);

  return { meta, world: snapshot, chronicle };
}

// ---------------------------------------------------------------------------
// Single item execution: bind -> call -> (retry | fallback | escalate)
// ---------------------------------------------------------------------------

interface ItemArgs {
  node: NodeSpec;
  agent: AgentSpec;
  index: number;
  item: unknown;
  total: number;
  ctx: EvalContext;
  deps: EngineDeps;
  models: ModelProfile[];
  providers: ProviderRegistry;
  cache: CallCache;
  chronicle: Chronicle;
  swaps: Record<string, string>;
  dryRun: boolean;
  allowUnavailable: boolean;
  temperature: number;
}

async function runItem(args: ItemArgs): Promise<ItemResult> {
  const { node, agent, index, item, total, ctx, deps, models, providers, cache, chronicle } = args;
  const fanOut = total > 1 || node.forEach !== undefined;
  const resolveFamily = makeFamilyResolver(models);

  const itemCtx: EvalContext = { ...ctx, item, itemIndex: index };
  const inputs = resolveInputs(node.in, itemCtx);

  const policy = { ...(node.bind ?? {}) };
  const swap = args.swaps[node.id];
  if (swap) policy.pin = swap;

  const exclude: string[] = [];
  let preferOverride: Prefer | undefined;
  let forceFallback = false;
  let retriesLeft = node.retries ?? 0;
  let fallbackAvailable = (node.bind?.fallback?.length ?? 0) > 0;
  let escalationsLeft = node.bind?.escalateIf ? 1 : 0;
  let attempts = 0;
  let lastError: Error | undefined;
  let costUsd = 0;
  let tokens = { in: 0, out: 0 };
  let cacheHits = 0;

  const nodeBudget = node.budget?.maxUsd ?? node.bind?.maxUsd;

  while (true) {
    attempts++;

    // Bind *inside* the loop: after a failure the excluded set has changed, so
    // the policy must be re-evaluated rather than replayed.
    const decision = resolveBinding({
      policy,
      models,
      availability: providers,
      evalCtx: itemCtx,
      ...(fanOut ? { itemIndex: index } : {}),
      strict: true,
      ...(preferOverride ? { preferOverride } : {}),
      ...(exclude.length ? { exclude } : {}),
      ...(forceFallback ? { forceFallback } : {}),
      allowUnavailable: args.allowUnavailable,
      resolveFamily,
      nodeId: node.id,
    });

    if (!decision.model) {
      chronicle.record('bind.resolve', { ok: false, reasons: decision.reasons, candidates: decision.candidates }, { node: node.id, item: index });
      // Not thrown: in a fan-out, one item failing to bind must not abort the
      // others. The join policy decides whether the node as a whole can survive.
      return failedItem({
        node,
        index,
        total,
        attempts,
        costUsd,
        tokens,
        cacheHits,
        error: new BindingError(
          `could not be bound.\n` +
            decision.reasons.map((r) => `    - ${r}`).join('\n') +
            summariseRejections(decision.candidates) +
            (lastError ? `\n  last provider error: ${lastError.message}` : ''),
          node.id,
        ),
      });
    }

    const model = decision.model;

    chronicle.record(
      'bind.resolve',
      {
        ok: true,
        model: model.id,
        family: model.family,
        provider: model.provider,
        source: decision.source,
        reasons: decision.reasons,
        candidates: decision.candidates,
        ...(swap ? { viaSwap: swap } : {}),
      },
      { node: node.id, item: index },
    );

    const request: CompletionRequest = {
      model: model.id,
      messages: buildMessages(agent, model, inputs, fanOut ? { index, total } : undefined),
      temperature: args.temperature,
      ...(model.maxOut !== undefined ? { maxOut: model.maxOut } : {}),
      expect: agent.out,
      cacheKey: '',
    };
    const key = hashCall(request);

    if (args.dryRun) {
      return {
        index,
        ok: true,
        model,
        record: {
          node: node.id,
          status: 'ok',
          model: model.id,
          provider: model.provider,
          bindingSource: decision.source,
          bindingReasons: decision.reasons,
          costUsd: 0,
          tokens: { in: 0, out: 0 },
          latencyMs: 0,
          attempts: 1,
          cacheHits: 0,
          items: total,
        },
      };
    }

    try {
      let response = args.deps.fresh ? undefined : cache.get(key, node.id);
      const fromCache = response !== undefined;

      if (!response) {
        const provider = providers.get(model.provider);
        if (!provider) {
          throw new Error(
            `no provider instance for "${model.provider}". ` +
              `Configure it in providers/${model.provider}.yaml or set the required API key.`,
          );
        }
        chronicle.record('llm.call', { model: model.id, attempts, messages: request.messages }, { node: node.id, item: index });
        response = await provider.complete(request);
        cache.set(key, response);
      }

      if (fromCache) cacheHits++;

      const usage = response.usage;
      const itemCost = (usage.in / 1_000_000) * model.cost.in + (usage.out / 1_000_000) * model.cost.out;

      // A cache hit costs nothing. This is the whole economic argument for the
      // content-addressed cache, and getting it wrong would make every replay
      // diff report spend that never happened.
      if (!fromCache) costUsd += itemCost;

      // Tokens are counted either way: they describe the payload that flowed
      // through the world, whether or not it was paid for this time.
      tokens = { in: tokens.in + usage.in, out: tokens.out + usage.out };

      chronicle.record(
        'llm.result',
        {
          model: model.id,
          cached: fromCache,
          latencyMs: fromCache ? 0 : response.latencyMs,
          usage,
          costUsd: round6(fromCache ? 0 : itemCost),
          ...(response.data ? { data: response.data } : { text: response.text }),
        },
        { node: node.id, item: index },
      );

      if (nodeBudget !== undefined && costUsd > nodeBudget) {
        throw new BudgetExceededError(
          `node "${node.id}" item ${index} exceeded its binding budget: ` +
            `$${costUsd.toFixed(4)} of $${nodeBudget.toFixed(4)}`,
        );
      }

      const output = response.data ?? { text: response.text };

      return {
        index,
        ok: true,
        model,
        output,
        record: {
          node: node.id,
          status: 'ok',
          model: model.id,
          provider: model.provider,
          bindingSource: decision.source,
          bindingReasons: decision.reasons,
          costUsd: round6(costUsd),
          tokens,
          latencyMs: fromCache ? 0 : response.latencyMs,
          attempts,
          cacheHits,
          items: total,
        },
      };
    } catch (err) {
      lastError = err as Error;
      exclude.push(model.id);

      chronicle.record(
        'llm.error',
        { model: model.id, attempt: attempts, error: (err as Error).message },
        { node: node.id, item: index },
      );

      if (err instanceof BudgetExceededError) throw err;

      if (retriesLeft > 0) {
        retriesLeft--;
        deps.log?.(
          `  ${pad(node.id)} ↻  ${model.id} failed (${short(err)}); retrying via re-bind ` +
            `(${retriesLeft} retries left)`,
        );
        continue;
      }

      // `fallback:` means what its name says: when the primary choice does not
      // work, go here instead. It is walked once, and it may relax resource
      // constraints but never safety ones.
      if (fallbackAvailable && node.bind?.fallback?.length) {
        fallbackAvailable = false;
        forceFallback = true;
        chronicle.record(
          'bind.escalate',
          {
            from: model.id,
            to: 'fallback',
            chain: node.bind.fallback,
            error: (err as Error).message,
          },
          { node: node.id, item: index },
        );
        deps.log?.(
          `  ${pad(node.id)} ⇩  ${model.id} failed; walking fallback [${node.bind.fallback.join(', ')}]`,
        );
        continue;
      }

      if (escalationsLeft > 0 && node.bind?.escalateIf) {
        escalationsLeft--;
        preferOverride = (node.bind.escalateIf.to ?? 'quality') as Prefer;
        forceFallback = false;
        chronicle.record(
          'bind.escalate',
          {
            from: model.id,
            to: preferOverride,
            error: (err as Error).message,
          },
          { node: node.id, item: index },
        );
        deps.log?.(
          `  ${pad(node.id)} ⇧  escalating to prefer=${preferOverride} after ${model.id} failed`,
        );
        continue;
      }

      // Recovery is exhausted. Return a failed item rather than throwing, so
      // that `join: any` / `quorum(n)` / `best_of(n)` can still salvage the
      // node from the items that did succeed. `applyJoin` turns the failure
      // into a node-level error when the policy does not permit partial results.
      return failedItem({ node, index, total, attempts, costUsd, tokens, cacheHits, model, error: err as Error });
    }
  }
}

/**
 * A fan-out item that could not be completed. Deliberately not an exception:
 * partial success is a first-class outcome in this engine, and the join policy
 * is where that decision belongs.
 */
function failedItem(args: {
  node: NodeSpec;
  index: number;
  total: number;
  attempts: number;
  costUsd: number;
  tokens: { in: number; out: number };
  cacheHits: number;
  model?: ModelProfile;
  error: Error;
}): ItemResult {
  return {
    index: args.index,
    ok: false,
    ...(args.model ? { model: args.model } : {}),
    record: {
      node: args.node.id,
      status: 'failed',
      ...(args.model ? { model: args.model.id, provider: args.model.provider } : {}),
      costUsd: round6(args.costUsd),
      tokens: args.tokens,
      latencyMs: 0,
      attempts: args.attempts,
      cacheHits: args.cacheHits,
      items: args.total,
      error: args.error.message,
    },
  };
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

export function buildMessages(
  agent: AgentSpec,
  model: ModelProfile,
  inputs: Record<string, unknown>,
  itemInfo?: { index: number; total: number },
): CompletionRequest['messages'] {
  const parts: string[] = [
    `# Role\n${agent.role}`,
    `# Instructions\n${agent.instructions}`,
  ];

  // Prompts do not port cleanly across vendors. Family-specific adaptations are
  // appended rather than substituted so the shared behaviour stays single-source.
  const adaptation = agent.promptByFamily?.[model.family];
  if (adaptation) {
    parts.push(`# Adaptations for the ${model.family} family\n${adaptation}`);
  }

  if (agent.tools?.length) {
    parts.push(`# Available tools\n${agent.tools.map((t) => `- ${t}`).join('\n')}`);
  }

  if (itemInfo && itemInfo.total > 1) {
    parts.push(
      `# Fan-out position\nYou are worker ${itemInfo.index + 1} of ${itemInfo.total}. ` +
        `Other workers are answering the same brief independently, possibly on different ` +
        `model families. Answer on your own judgement; do not try to guess or defer to them.`,
    );
  }

  parts.push(
    `# Output contract\n` +
      `Reply with a single JSON object containing exactly these keys:\n` +
      describeContract(agent.out) +
      `\nNo prose outside the JSON object.`,
  );

  return [
    { role: 'system', content: parts.join('\n\n') },
    { role: 'user', content: `# Inputs\n${JSON.stringify(inputs, null, 2)}` },
  ];
}

function describeContract(contract: Contract): string {
  return Object.entries(contract)
    .map(([name, spec]) => {
      const extra = spec.schema ? ` (shape: ${spec.schema})` : '';
      return `- "${name}": ${spec.type}${extra}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Graph + scheduling helpers
// ---------------------------------------------------------------------------

/** Stable topological order: dependencies first, declaration order as tie-break. */
export function topoOrder(nodes: readonly NodeSpec[]): NodeSpec[] {
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const done = new Set<string>();
  const out: NodeSpec[] = [];
  const remaining = [...nodes];

  while (remaining.length > 0) {
    const ready = remaining.filter((n) => (n.needs ?? []).every((d) => done.has(d)));
    if (ready.length === 0) {
      throw new Error(
        `dependency cycle among: ${remaining.map((n) => n.id).join(', ')}`,
      );
    }
    ready.sort((a, b) => (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0));
    const next = ready[0]!;
    out.push(next);
    done.add(next.id);
    remaining.splice(remaining.indexOf(next), 1);
  }

  void byId;
  return out;
}

function resolveItems(node: NodeSpec, ctx: EvalContext): unknown[] {
  if (!node.forEach) return [undefined];
  const value = resolveRef(node.forEach, ctx);
  if (value === undefined || value === null) {
    throw new Error(
      `node "${node.id}" fans out over \`${node.forEach}\`, which is empty. ` +
        `Check that the producing node writes that world field and is listed in \`needs:\`.`,
    );
  }
  if (Array.isArray(value)) return value;
  return [value];
}

function applyJoin(
  node: NodeSpec,
  all: ItemResult[],
  successes: ItemResult[],
): ItemResult[] {
  const spec = (node.join ?? 'all').trim();
  const quorum = /^quorum\(\s*(\d+)\s*\)$/.exec(spec);
  const bestOf = /^best_of\(\s*(\d+)\s*\)$/.exec(spec);

  if (spec === 'all') {
    const failed = all.filter((r) => !r.ok);
    if (failed.length > 0) {
      // Surface the underlying cause, not just the headcount - "1/1 items
      // failed" on its own tells an operator nothing actionable.
      const first = failed[0]!.record.error ?? 'unknown error';
      throw new Error(
        `node "${node.id}" join=all: ${failed.length}/${all.length} item(s) failed. ` +
          `First failure: ${first}`,
      );
    }
    return successes;
  }

  if (spec === 'any') {
    if (successes.length === 0) {
      const first = all[0]?.record.error ?? 'unknown error';
      throw new Error(`node "${node.id}" join=any: every item failed. First failure: ${first}`);
    }
    return successes;
  }

  if (quorum) {
    const need = Number(quorum[1]);
    if (successes.length < need) {
      const first = all.find((r) => !r.ok)?.record.error ?? 'unknown error';
      throw new Error(
        `node "${node.id}" join=quorum(${need}): only ${successes.length} of ${all.length} ` +
          `item(s) succeeded. First failure: ${first}`,
      );
    }
    return successes;
  }

  if (bestOf) {
    const n = Math.max(1, Number(bestOf[1]));
    if (successes.length === 0) {
      const first = all[0]?.record.error ?? 'unknown error';
      throw new Error(`node "${node.id}" join=best_of(${n}): every item failed. First failure: ${first}`);
    }
    // Rank on the confidence the agent itself declared; M1 replaces this with a
    // cross-family judge call, which is the point of having a judge agent.
    const ranked = [...successes].sort((a, b) => scoreOf(b.output) - scoreOf(a.output));
    return ranked.slice(0, n);
  }

  throw new Error(
    `node "${node.id}" has unknown join policy "${spec}". ` +
      `Expected: all, any, quorum(n), or best_of(n)`,
  );
}

function scoreOf(output: Record<string, unknown> | undefined): number {
  if (!output) return 0;
  for (const key of ['confidence', 'score', 'weight']) {
    const v = output[key];
    if (typeof v === 'number') return v;
    if (v !== null && typeof v === 'object') {
      const inner = (v as Record<string, unknown>)['confidence'];
      if (typeof inner === 'number') return inner;
    }
  }
  return 0;
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function emptyRecord(node: string, status: NodeRunRecord['status']): NodeRunRecord {
  return {
    node,
    status,
    costUsd: 0,
    tokens: { in: 0, out: 0 },
    latencyMs: 0,
    attempts: 0,
    cacheHits: 0,
  };
}

function mergeRecords(node: string, all: ItemResult[], accepted: ItemResult[]): NodeRunRecord {
  const base = emptyRecord(node, all.every((r) => r.ok) ? 'ok' : 'failed');
  base.costUsd = round6(all.reduce((s, r) => s + r.record.costUsd, 0));
  base.tokens = {
    in: all.reduce((s, r) => s + r.record.tokens.in, 0),
    out: all.reduce((s, r) => s + r.record.tokens.out, 0),
  };
  base.latencyMs = all.reduce((s, r) => Math.max(s, r.record.latencyMs), 0);
  base.attempts = all.reduce((s, r) => s + r.record.attempts, 0);
  base.cacheHits = all.reduce((s, r) => s + r.record.cacheHits, 0);
  base.items = all.length;
  const first = accepted[0] ?? all[0];
  if (first?.model) {
    base.model = first.model.id;
    base.provider = first.model.provider;
    base.bindingSource = first.record.bindingSource;
    base.bindingReasons = first.record.bindingReasons;
  }
  return base;
}

function familyKey(model: ModelProfile, models: readonly ModelProfile[]): string {
  return models.find((m) => m.id === model.id)?.family ?? model.family;
}

/**
 * When nothing can be bound, the useful output is not "no candidate survived"
 * but *why the field was empty*. Grouping identical rejections keeps the message
 * readable when the registry has dozens of models.
 */
function summariseRejections(candidates: readonly CandidateReport[]): string {
  const rejected = candidates.filter((c) => !c.ok);
  if (rejected.length === 0) return '';

  const groups = new Map<string, string[]>();
  for (const c of rejected) {
    const key = c.reasons.join(' + ') || 'rejected';
    const list = groups.get(key) ?? [];
    list.push(c.id);
    groups.set(key, list);
  }

  const lines = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 6)
    .map(([reason, ids]) => {
      const sample = ids.slice(0, 3).join(', ');
      const more = ids.length > 3 ? `, +${ids.length - 3} more` : '';
      return `      ${ids.length}× ${sample}${more}\n         because: ${reason}`;
    });

  return `\n  ${rejected.length} candidate(s) rejected:\n${lines.join('\n')}`;
}

function pad(s: string, width = 12): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function short(err: unknown): string {
  const msg = (err as Error).message ?? String(err);
  return msg.length > 90 ? `${msg.slice(0, 89)}…` : msg;
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
