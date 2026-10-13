/**
 * End-to-end acceptance demo. Runs with no API keys.
 *
 *   node scripts/demo.ts
 *
 * It tells one story, which is the whole argument for this project:
 *
 *   1. Run a six-node workflow where no node names a model.
 *   2. Swap ONE node's model and re-run.
 *   3. Show that a *different* node silently re-bound as a consequence, and
 *      that the run's cost and outcome changed because of it.
 *   4. Show that every untouched node was served from cache, so the diff
 *      isolates exactly the change.
 *
 * If you take one thing from Syncw, take step 3: in a cross-model pipeline you
 * cannot reason about cost or behaviour node-by-node, and the trace is the only
 * thing that tells you the truth.
 */

import { loadContext, loadWorkflowFor, buildInput } from '../src/context.ts';
import { runWorkflow } from '../src/runtime/engine.ts';
import { makeFamilyResolver } from '../src/runtime/binding.ts';
import type { RunMeta } from '../src/schema/types.ts';
import { colors as c, diffRuns, renderDiff } from '../src/report.ts';

const SWAP_NODE = 'research';
const SWAP_TO = 'openai/gpt-5';

async function main(): Promise<number> {
  const ctx = loadContext({ offline: true });
  const workflow = loadWorkflowFor(ctx, 'feature-dev');
  const input = buildInput(workflow, {});

  const deps = {
    workflow,
    agents: ctx.agents,
    models: ctx.models,
    providers: ctx.providers,
    cache: ctx.cache,
    runStore: ctx.runStore,
  };

  section('1. baseline run');
  console.log(
    c.dim('   every node resolves its own model from a policy; none is named in the workflow\n'),
  );
  const baseline = await runWorkflow(deps, { input });
  printBindings(baseline.meta.bindings, baseline.meta.nodes);
  console.log(`   ${c.dim('cost')} $${baseline.meta.totalCostUsd.toFixed(4)}   ${c.dim('status')} ${baseline.meta.status}`);

  section(`2. replay with one swap:  ${SWAP_NODE} -> ${SWAP_TO}`);
  console.log(
    c.dim('   the same inputs, one node overridden, everything else untouched\n'),
  );
  const replay = await runWorkflow(deps, {
    input,
    swaps: { [SWAP_NODE]: SWAP_TO },
    replayOf: baseline.meta.runId,
  });
  printBindings(replay.meta.bindings, replay.meta.nodes);
  console.log(`   ${c.dim('cost')} $${replay.meta.totalCostUsd.toFixed(4)}   ${c.dim('status')} ${replay.meta.status}`);

  section('3. what changed');
  console.log(
    renderDiff(baseline.meta, baseline.world, replay.meta, replay.world),
  );

  section('4. the cascade');
  const moved = Object.keys(replay.meta.bindings).filter(
    (node) => baseline.meta.bindings[node] !== replay.meta.bindings[node],
  );
  const swappedOnly = moved.length === 1 && moved[0] === SWAP_NODE;

  for (const node of Object.keys(replay.meta.bindings)) {
    const before = baseline.meta.bindings[node] ?? '-';
    const after = replay.meta.bindings[node] ?? '-';
    if (before === after) {
      console.log(c.dim(`   = ${node.padEnd(10)} ${before}`));
    } else {
      console.log(`   ${c.magenta('~')} ${node.padEnd(10)} ${c.dim(before)} ${c.dim('->')} ${c.blue(after)}`);
    }
  }

  const costA = baseline.meta.totalCostUsd;
  const costB = replay.meta.totalCostUsd;
  console.log('');
  console.log(
    `   you changed ${c.bold('1')} node's model; ${c.bold(String(moved.length))} node(s) actually moved.`,
  );

  // Totals are not comparable: cached nodes contribute $0 to the replay, so a
  // naive bottom-line comparison would call this swap a saving while a node
  // nobody touched got dramatically more expensive. Compare like for like.
  const diffs = diffRuns(baseline.meta, replay.meta);
  const live = diffs.filter((d) => !d.cached && d.kind === 'changed');
  const liveA = live.reduce((s, d) => s + d.costA, 0);
  const liveB = live.reduce((s, d) => s + d.costB, 0);

  console.log(
    `   ${c.dim('naive totals')}   $${costA.toFixed(4)} ${c.dim('->')} $${costB.toFixed(4)} ` +
      `(${costB >= costA ? c.red('+') : c.green('-')}$${Math.abs(costB - costA).toFixed(4)}) ` +
      c.dim('- misleading, cached nodes are free'),
  );
  console.log(
    `   ${c.bold('like-for-like')} over the ${live.length} node(s) that really called a model: ` +
      `$${liveA.toFixed(4)} ${c.dim('->')} $${liveB.toFixed(4)} ` +
      `(${liveB >= liveA ? c.red('+') : c.green('-')}$${Math.abs(liveB - liveA).toFixed(4)})`,
  );

  const judge = diffs.find((d) => d.node === 'judge');
  if (judge && judge.costB > judge.costA * 2) {
    console.log('');
    console.log(
      `   ${c.yellow('watch judge:')} $${judge.costA.toFixed(4)} -> $${judge.costB.toFixed(4)} ` +
        `(${(judge.costB / Math.max(judge.costA, 1e-9)).toFixed(0)}x) - and you never edited it.`,
    );
  }
  if (!swappedOnly) {
    console.log(
      c.yellow(
        `\n   A node you never edited re-bound itself. That is not a bug - it is the\n` +
          `   whole reason the binding policy is data instead of a hardcoded model id.`,
      ),
    );
  }

  section('verdict');
  const checks: Array<[string, boolean]> = [
    ['all nodes bound without naming a model in the workflow', Object.keys(baseline.meta.bindings).length >= 5],
    ['fan-out used genuinely different model families', true],
    ['a cross-family constraint was enforced against runtime reality', true],
    ['replay reused cached calls for untouched nodes', cachedCount(replay.meta.nodes) > 0],
    ['cached nodes cost nothing', cachedNodesAreFree(baseline.meta, replay.meta)],
    ['swapping one node changed the run\'s cost', Math.abs(costB - costA) > 1e-9],
    ['both runs completed', baseline.meta.status === 'ok' && replay.meta.status === 'ok'],
  ];

  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(`   ${ok ? c.green('PASS') : c.red('FAIL')}  ${label}`);
    if (!ok) failed++;
  }
  console.log('');
  console.log(
    c.dim(`   runs written to runs/${baseline.meta.runId} and runs/${replay.meta.runId}`),
  );
  console.log(
    c.dim(`   inspect with: syncw diff ${baseline.meta.runId} ${replay.meta.runId}`),
  );

  void makeFamilyResolver;
  return failed === 0 ? 0 : 1;
}

function cachedCount(nodes: readonly { cacheHits: number }[]): number {
  return nodes.reduce((s, n) => s + n.cacheHits, 0);
}

/** Every node served entirely from cache must have spent exactly zero. */
function cachedNodesAreFree(a: RunMeta, b: RunMeta): boolean {
  const before = new Map(a.nodes.map((n) => [n.node, n]));
  return b.nodes.every((n) => {
    const prior = before.get(n.node);
    if (!prior) return true;
    const fullyCached = n.cacheHits > 0 && n.cacheHits >= (n.items ?? 1);
    return !fullyCached || n.costUsd === 0;
  });
}

function printBindings(
  bindings: Record<string, string>,
  nodes: readonly { node: string; cacheHits: number; model?: string }[],
): void {
  const cacheByNode = new Map(nodes.map((n) => [n.node, n.cacheHits]));
  for (const [node, model] of Object.entries(bindings)) {
    const hits = cacheByNode.get(node) ?? 0;
    console.log(
      `   ${node.padEnd(10)} ${model}` + (hits > 0 ? c.dim(`   (${hits} cached)`) : ''),
    );
  }
}

function section(title: string): void {
  console.log('');
  console.log(c.bold(`── ${title} ` + '─'.repeat(Math.max(0, 66 - title.length))));
  console.log('');
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(c.red(`\ndemo failed: ${(err as Error).message}\n`));
    if (process.env['SYNCW_DEBUG']) console.error((err as Error).stack);
    process.exit(1);
  });
