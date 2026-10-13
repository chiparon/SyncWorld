#!/usr/bin/env node
/**
 * Syncw CLI.
 *
 *   syncw models                     list the model capability registry
 *   syncw providers                  show which providers this machine can reach
 *   syncw bind   <workflow>          resolve every binding WITHOUT calling a model
 *   syncw run    <workflow>          execute
 *   syncw runs                       list past runs
 *   syncw show   <runId>             run summary
 *   syncw explain <runId>            the binding decisions that run made, with candidates
 *   syncw replay <runId> [--swap …]  re-run the same inputs, optionally on other models
 *   syncw diff   <runA> <runB>       node-by-node comparison
 *
 * The load-bearing pair is `replay` + `diff`: swap one node's model, re-run, and
 * see exactly what changed and what it cost, with every untouched node served
 * from the content-addressed cache.
 */

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';

import type { NodeSpec, WorkflowSpec } from './schema/types.ts';
import type { ProjectContext } from './context.ts';
import type { PlanRow } from './report.ts';

import { SyncwConfigError } from './schema/load.ts';
import { buildInput, loadContext, loadWorkflowFor } from './context.ts';
import { BindingError, makeFamilyResolver, resolveBinding } from './runtime/binding.ts';
import { runWorkflow, topoOrder } from './runtime/engine.ts';
import type { EngineDeps } from './runtime/engine.ts';
import { evalGuard } from './runtime/refs.ts';
import type { EvalContext, NodeView } from './runtime/refs.ts';
import { World } from './runtime/world.ts';
import {
  colors as c,
  renderBindingPlan,
  renderDiff,
  renderModels,
  renderProviders,
  renderRunSummary,
} from './report.ts';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface Args {
  command: string;
  positional: string[];
  input: Record<string, unknown>;
  swaps: Record<string, string>;
  explain: boolean;
  full: boolean;
  quiet: boolean;
  yes: boolean;
  fresh: boolean;
  allProviders: boolean;
  offline: boolean | undefined;
  json: boolean;
  root: string | undefined;
  mockFail: string[] | undefined;
}

const FLAGS = new Set([
  'explain', 'full', 'quiet', 'yes', 'fresh', 'all-providers', 'json', 'help',
]);

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    command: argv[0] ?? 'help',
    positional: [],
    input: {},
    swaps: {},
    explain: false,
    full: false,
    quiet: false,
    yes: false,
    fresh: false,
    allProviders: false,
    offline: undefined,
    json: false,
    root: undefined,
    mockFail: undefined,
  };

  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) {
      args.positional.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    const name = (eq === -1 ? token.slice(2) : token.slice(2, eq)).toLowerCase();
    const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);
    const nextValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const v = argv[++i];
      if (v === undefined) throw new SyncwConfigError(`--${name} needs a value`);
      return v;
    };

    if (FLAGS.has(name)) {
      const on = inlineValue === undefined ? true : inlineValue !== 'false';
      if (name === 'explain') args.explain = on;
      else if (name === 'full') args.full = on;
      else if (name === 'quiet') args.quiet = on;
      else if (name === 'yes') args.yes = on;
      else if (name === 'fresh') args.fresh = on;
      else if (name === 'all-providers') args.allProviders = on;
      else if (name === 'json') args.json = on;
      else if (name === 'help') args.command = 'help';
      continue;
    }

    switch (name) {
      case 'input': {
        const raw = nextValue();
        const split = raw.indexOf('=');
        if (split === -1) {
          throw new SyncwConfigError(`--input expects key=value, got "${raw}"`);
        }
        args.input[raw.slice(0, split)] = coerce(raw.slice(split + 1));
        break;
      }
      case 'input-json': {
        const parsed = JSON.parse(nextValue()) as Record<string, unknown>;
        Object.assign(args.input, parsed);
        break;
      }
      case 'set':
      case 'swap': {
        const raw = nextValue();
        const split = raw.indexOf('=');
        if (split === -1) {
          throw new SyncwConfigError(`--${name} expects node=model, got "${raw}"`);
        }
        args.swaps[raw.slice(0, split)] = raw.slice(split + 1);
        break;
      }
      case 'root':
        args.root = nextValue();
        break;
      case 'offline':
        args.offline = inlineValue === undefined ? true : inlineValue !== 'false';
        break;
      case 'no-offline':
        args.offline = false;
        break;
      case 'mock-fail':
        args.mockFail = nextValue().split(',').map((s) => s.trim()).filter(Boolean);
        break;
      default:
        throw new SyncwConfigError(
          `unknown option --${name}. Run \`syncw help\` for usage.`,
        );
    }
  }

  return args;
}

function coerce(raw: string): unknown {
  const t = raw.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.parse(t);
    } catch {
      return raw;
    }
  }
  const n = Number(t);
  if (t !== '' && Number.isFinite(n) && /^-?\d/.test(t)) return n;
  return raw;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'help' || args.command === '') {
    printHelp();
    return 0;
  }

  const ctx = loadContext({
    ...(args.root ? { root: args.root } : {}),
    ...(args.offline !== undefined ? { offline: args.offline } : {}),
    ...(args.mockFail ? { failPatterns: args.mockFail } : {}),
  });

  if (ctx.offline && !args.quiet && OFFLINE_NOTICE_COMMANDS.has(args.command)) {
    console.log(
      c.yellow('  offline mode: ') +
        c.dim(
          'no provider credentials found, so every model is served by the synthesiser. ' +
            'Set an API key (see `syncw providers`) or SYNCW_OFFLINE=0 to change this.',
        ),
    );
  }

  switch (args.command) {
    case 'models':
      console.log(renderModels(ctx.models));
      console.log(c.dim(`\n  ${ctx.models.length} models across ${new Set(ctx.models.map((m) => m.provider)).size} providers.`));
      return 0;

    case 'providers':
      console.log(renderProviders(ctx.providers.describe()));
      return 0;

    case 'runs': {
      const runs = ctx.runStore.list().reverse();
      if (runs.length === 0) {
        console.log(c.dim('  no runs yet. Try `syncw run hello`.'));
        return 0;
      }
      for (const id of runs) {
        const meta = ctx.runStore.readMeta(id);
        const badge =
          meta.status === 'ok' ? c.green('ok') : meta.status === 'failed' ? c.red('failed') : c.yellow(meta.status);
        console.log(
          `  ${id}  ${badge}  $${meta.totalCostUsd.toFixed(4)}  ${c.dim(meta.workflow)}` +
            (meta.replayOf ? c.dim(`  (replay of ${meta.replayOf})`) : ''),
        );
      }
      return 0;
    }

    case 'show': {
      const id = ctx.runStore.resolveId(requirePositional(args, 0, 'show <runId>'));
      console.log(renderRunSummary(ctx.runStore.readMeta(id), true));
      return 0;
    }

    case 'explain':
      return cmdExplain(ctx, args);

    case 'bind':
      return cmdBind(ctx, args);

    case 'run':
      return cmdRun(ctx, args);

    case 'replay':
      return cmdReplay(ctx, args);

    case 'diff':
      return cmdDiff(ctx, args);

    default:
      console.error(c.red(`unknown command "${args.command}"`));
      printHelp();
      return 1;
  }
}

function requirePositional(args: Args, index: number, usage: string): string {
  const value = args.positional[index];
  if (!value) throw new SyncwConfigError(`missing argument. Usage: syncw ${usage}`);
  return value;
}

/**
 * Commands that spend money get told when they are not spending money.
 * `models` and `providers` already make the routing visible in their output.
 */
const OFFLINE_NOTICE_COMMANDS = new Set(['run', 'replay', 'bind']);

// ---------------------------------------------------------------------------
// bind - the dry run that makes the design legible
// ---------------------------------------------------------------------------

function cmdBind(ctx: ProjectContext, args: Args): number {
  const workflow = loadWorkflowFor(ctx, requirePositional(args, 0, 'bind <workflow>'));
  const input = buildInput(workflow, args.input);
  const rows = planBindings(ctx, workflow, input, args);

  console.log(
    renderBindingPlan(workflow, rows, { explain: args.explain || args.full }),
  );
  console.log(
    c.dim(
      `\n  dry run: no provider was called. ` +
        `${args.allProviders ? 'including' : 'excluding'} models whose credentials are missing.` +
        (args.allProviders ? '' : ' Use --all-providers to preview everything.'),
    ),
  );
  return rows.some((r) => !r.decision.model) ? 1 : 0;
}

/**
 * Predict every binding without executing anything.
 *
 * Predictions are fed forward: a downstream `not_family_of: $.nodes.x.actual_model`
 * is checked against the model node x is *predicted* to run on, so the plan you
 * read is the plan you get.
 */
function planBindings(
  ctx: ProjectContext,
  workflow: WorkflowSpec,
  input: Record<string, unknown>,
  args: Args,
): PlanRow[] {
  const world = new World(workflow.world);
  const nodeViews = new Map<string, NodeView>();
  const rows: PlanRow[] = [];
  const resolveFamily = makeFamilyResolver(ctx.models);

  for (const node of topoOrder(workflow.nodes)) {
    const ctxEval: EvalContext = { input, world, nodes: nodeViews };

    if (node.when) {
      let pass = true;
      try {
        pass = evalGuard(node.when, ctxEval);
      } catch {
        pass = false;
      }
      if (!pass) {
        nodeViews.set(node.id, { status: 'skipped' });
        continue;
      }
    }

    if (node.kind === 'human_gate') {
      nodeViews.set(node.id, { status: 'ok' });
      rows.push({
        node: node.id,
        fanOut: false,
        decision: {
          model: null,
          source: 'human_gate',
          candidates: [],
          reasons: ['human gate - no model binding'],
        },
      });
      continue;
    }

    // Nominal fan-out width: we cannot know the real item count before the
    // producing node runs, so use the declared heterogeneity when present.
    const itemIndexes: number[] =
      node.forEach === undefined
        ? [0]
        : node.bind?.byIndex?.length
          ? Array.from({ length: node.bind.byIndex.length }, (_, i) => i)
          : [0];
    const fanOut = node.forEach !== undefined;

    let firstDecision: PlanRow['decision'] | undefined;
    const models: string[] = [];
    const families: string[] = [];

    for (const index of itemIndexes) {
      const decision = resolveBinding({
        policy: args.swaps[node.id] ? { ...node.bind, pin: args.swaps[node.id] } : node.bind,
        models: ctx.models,
        availability: ctx.providers,
        evalCtx: ctxEval,
        ...(fanOut ? { itemIndex: index } : {}),
        strict: false,
        allowUnavailable: args.allProviders,
        resolveFamily,
        nodeId: node.id,
      });
      if (!firstDecision) firstDecision = decision;
      if (decision.model) {
        models.push(decision.model.id);
        families.push(decision.model.family);
      }
    }

    if (firstDecision) rows.push({ node: node.id, decision: firstDecision, fanOut });

    const uniqueModels = [...new Set(models)];
    const uniqueFamilies = [...new Set(families)];
    nodeViews.set(node.id, {
      ...(uniqueModels[0] ? { actual_model: uniqueModels[0] } : {}),
      ...(uniqueFamilies[0] ? { actual_family: uniqueFamilies[0] } : {}),
      actual_models: uniqueModels,
      actual_families: uniqueFamilies,
      status: 'ok',
      cost_usd: 0,
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function cmdRun(ctx: ProjectContext, args: Args): Promise<number> {
  const workflow = loadWorkflowFor(ctx, requirePositional(args, 0, 'run <workflow>'));
  const input = buildInput(workflow, args.input);
  const quiet = args.quiet;

  const deps = makeDeps(ctx, workflow, args, quiet);
  const result = await runWorkflow(deps, { input });

  if (!quiet) {
    console.log(renderRunSummary(result.meta, args.explain));
    console.log(c.dim(`\n  trace  runs/${result.meta.runId}/trace.jsonl`));
    console.log(c.dim(`  world  runs/${result.meta.runId}/world.json`));
  } else if (args.json) {
    console.log(JSON.stringify(result.meta, null, 2));
  }

  if (result.meta.status === 'ok') return 0;
  console.error(c.red(`\n  run ${result.meta.status}: ${result.meta.error ?? ''}`));
  return 1;
}

function makeDeps(ctx: ProjectContext, workflow: WorkflowSpec, args: Args, quiet: boolean): EngineDeps {
  const deps: EngineDeps = {
    workflow,
    agents: ctx.agents,
    models: ctx.models,
    providers: ctx.providers,
    cache: ctx.cache,
    runStore: ctx.runStore,
    allowUnavailableProviders: args.allProviders,
  };

  if (!quiet) {
    deps.log = (line) => console.log(line);
  }
  if (args.fresh) deps.fresh = true;

  deps.onHumanGate = async (node: NodeSpec, inputs: Record<string, unknown>) => {
    if (args.yes || !process.stdin.isTTY) {
      return true;
    }
    console.log('');
    console.log(c.yellow(`  human gate: ${node.id}`));
    console.log(c.dim(`  ${JSON.stringify(inputs, null, 2).split('\n').join('\n  ')}`));
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question('  approve? [Y/n] ')).trim().toLowerCase();
      return answer === '' || answer === 'y' || answer === 'yes';
    } finally {
      rl.close();
    }
  };

  return deps;
}

// ---------------------------------------------------------------------------
// replay + diff
// ---------------------------------------------------------------------------

async function cmdReplay(ctx: ProjectContext, args: Args): Promise<number> {
  const sourceId = ctx.runStore.resolveId(requirePositional(args, 0, 'replay <runId>'));
  const source = ctx.runStore.readMeta(sourceId);
  const workflow = loadWorkflowFor(ctx, source.workflow);

  if (Object.keys(args.swaps).length === 0) {
    console.log(
      c.dim(
        `  no --swap given: this replays identically. Every call should be served from ` +
          `cache. Add e.g. \`--swap plan=openai/gpt-5\` to see the diff machinery work.`,
      ),
    );
  }

  const deps = makeDeps(ctx, workflow, args, args.quiet);
  const result = await runWorkflow(deps, {
    input: source.input,
    swaps: args.swaps,
    replayOf: sourceId,
  });

  console.log(renderRunSummary(result.meta));
  console.log('');
  console.log(renderDiff(source, ctx.runStore.readWorld(sourceId), result.meta, result.world, { full: args.full }));

  return result.meta.status === 'ok' ? 0 : 1;
}

function cmdDiff(ctx: ProjectContext, args: Args): number {
  const aId = ctx.runStore.resolveId(requirePositional(args, 0, 'diff <runA> <runB>'));
  const bId = ctx.runStore.resolveId(requirePositional(args, 1, 'diff <runA> <runB>'));
  const a = ctx.runStore.readMeta(aId);
  const b = ctx.runStore.readMeta(bId);
  console.log(renderDiff(a, ctx.runStore.readWorld(aId), b, ctx.runStore.readWorld(bId), { full: args.full }));
  return 0;
}

// ---------------------------------------------------------------------------
// explain
// ---------------------------------------------------------------------------

function cmdExplain(ctx: ProjectContext, args: Args): number {
  const id = ctx.runStore.resolveId(requirePositional(args, 0, 'explain <runId>'));
  const meta = ctx.runStore.readMeta(id);
  const events = ctx.runStore.readTrace(id).filter((e) => e.type === 'bind.resolve');

  console.log('');
  console.log(c.bold(`binding decisions  ${id}`) + c.dim(`  (${meta.workflow})`));
  console.log('');

  let current = '';
  for (const event of events) {
    const data = event.data as {
      ok?: boolean;
      model?: string;
      source?: string;
      reasons?: string[];
      candidates?: Array<{ id: string; ok: boolean; reasons: string[]; score?: number }>;
      viaSwap?: string;
    };
    if (event.node !== current) {
      current = event.node ?? '';
      console.log(c.bold(`  ${current}`));
    }
    const itemTag = event.item !== undefined ? c.dim(` [item ${event.item}]`) : '';
    if (!data.ok) {
      console.log(`    ${c.red('UNBOUND')}${itemTag} ${(data.reasons ?? []).join('; ')}`);
      continue;
    }
    console.log(
      `    ${c.green('→')} ${c.bold(data.model ?? '')}${itemTag} ` +
        c.dim(`via ${data.source}${data.viaSwap ? ` (swap: ${data.viaSwap})` : ''}`),
    );
    for (const reason of data.reasons ?? []) console.log(c.dim(`        · ${reason}`));
    if (args.explain || args.full) {
      for (const cand of data.candidates ?? []) {
        const mark = cand.ok ? c.green('✓') : c.dim('✗');
        const score = cand.score !== undefined ? c.dim(` [${cand.score.toFixed(3)}]`) : '';
        console.log(`        ${mark} ${cand.id}${score} ${c.dim(cand.reasons.join('; '))}`);
      }
    }
  }

  if (events.length === 0) console.log(c.dim('  no binding events recorded.'));
  console.log('');
  return 0;
}

// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`
${c.bold('syncw')} - Synchronized World

${c.bold('USAGE')}
  syncw <command> [options]

${c.bold('COMMANDS')}
  ${c.blue('models')}                       list the model capability registry
  ${c.blue('providers')}                    which providers this machine can actually reach
  ${c.blue('bind')}   <workflow>            resolve every binding WITHOUT calling a model
  ${c.blue('run')}    <workflow>            execute a workflow
  ${c.blue('runs')}                         list past runs
  ${c.blue('show')}   <runId>               run summary
  ${c.blue('explain')} <runId>              binding decisions, with the full candidate list
  ${c.blue('replay')} <runId>               re-run the same inputs, optionally on other models
  ${c.blue('diff')}   <runA> <runB>         node-by-node comparison

${c.bold('OPTIONS')}
  --input key=value        supply a workflow input (repeatable)
  --input-json '{...}'     supply inputs as JSON
  --set node=model         pin one node's model for this run (alias: --swap)
  --all-providers          preview bindings even without credentials
  --offline                force every model through the offline synthesiser
  --no-offline             require real credentials
  --fresh                  bypass the call cache
  --yes                    auto-approve human gates
  --explain                show full candidate lists and reasons
  --full                   show every diff field
  --json                   machine-readable output where supported
  --quiet                  suppress the live node log
  --root <dir>             project root (defaults to cwd)

${c.bold('THE ONE TO TRY')}
  ${c.dim('$')} syncw run feature-dev
  ${c.dim('$')} syncw replay ${c.dim('<runId>')} --swap research=openai/gpt-5
  ${c.dim('#')} swap one node's model, re-run, and see exactly what changed -
  ${c.dim('#')} every untouched node is served from the content-addressed cache.
`);
}

const entry = process.argv[1];
const isEntryPoint = entry !== undefined && pathToFileURL(entry).href === import.meta.url;

if (isEntryPoint) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      const e = err as Error;
      if (e instanceof SyncwConfigError || e instanceof BindingError) {
        console.error(c.red(`\n  ${e.name}: ${e.message}\n`));
      } else {
        console.error(c.red(`\n  ${e.name || 'Error'}: ${e.message}\n`));
        if (process.env['SYNCW_DEBUG']) console.error(e.stack);
      }
      process.exit(1);
    });
}

export { main, parseArgs, coerce };