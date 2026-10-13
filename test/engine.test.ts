/**
 * End-to-end engine tests against the offline synthesiser.
 *
 * These cover the mechanisms that the CLI demo only exercises implicitly:
 * fan-out + join arithmetic, the retry / fallback / escalate ordering, run
 * budgets, and the loader's structural validation.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentSpec, ModelProfile, ProviderConfig } from '../src/schema/types.ts';
import type { EngineDeps } from '../src/runtime/engine.ts';

import { SyncwConfigError, parseWorkflow } from '../src/schema/load.ts';
import { createProviderRegistry } from '../src/providers/index.ts';
import { CallCache } from '../src/runtime/cache.ts';
import { RunStore } from '../src/runtime/trace.ts';
import { runWorkflow } from '../src/runtime/engine.ts';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const TMP: string[] = [];

after(() => {
  for (const dir of TMP) rmSync(dir, { recursive: true, force: true });
});

function model(
  id: string,
  family: string,
  cost: { in: number; out: number },
  quality: number,
): ModelProfile {
  return {
    id,
    provider: 'mock',
    family,
    ctx: 128_000,
    caps: ['json_schema'],
    cost,
    quality,
    latencyP50Ms: 300,
  };
}

// blended cost = in + 3*out -> cheap 1, premium 30
const CHEAP = model('mock/cheap', 'cheap', { in: 0.1, out: 0.3 }, 0.3);
const PREMIUM = model('mock/premium', 'premium', { in: 3, out: 9 }, 0.95);
const THIRD = model('mock/third', 'third', { in: 1, out: 3 }, 0.7);

const WORKER: AgentSpec = {
  name: 'worker',
  role: 'a test worker',
  instructions: 'Produce the requested fields.',
  out: {
    confidence: { type: 'number' },
    note: { type: 'string' },
  },
};

function harness(
  models: ModelProfile[],
  failPatterns: string[] = [],
): { deps: EngineDeps; runs: string } {
  const root = mkdtempSync(join(tmpdir(), 'syncw-test-'));
  TMP.push(root);

  const configs = new Map<string, ProviderConfig>([['mock', { name: 'mock', kind: 'mock' }]]);

  return {
    runs: root,
    deps: {
      workflow: undefined as never, // replaced per test
      agents: new Map([['worker', WORKER]]),
      models,
      providers: createProviderRegistry(configs, models, { failPatterns }),
      cache: new CallCache(join(root, '.syncw', 'cache')),
      runStore: RunStore.open(root),
    },
  };
}

function depsFor(
  yaml: string,
  models: ModelProfile[] = [CHEAP, PREMIUM, THIRD],
  failPatterns: string[] = [],
): EngineDeps {
  const h = harness(models, failPatterns);
  return { ...h.deps, workflow: parseWorkflow(yaml, '<test>') };
}

// ---------------------------------------------------------------------------
// Loading + structural validation
// ---------------------------------------------------------------------------

describe('workflow loading', () => {
  test('needs defaults to the previous node, so linear flows need no ceremony', () => {
    const wf = parseWorkflow(
      `
name: linear
world:
  a: { type: json, merge: replace }
  b: { type: json, merge: replace }
nodes:
  - { id: one, agent: worker, out: [a] }
  - { id: two, agent: worker, out: [b] }
`,
      '<test>',
    );
    assert.deepEqual(wf.nodes[0]!.needs, []);
    assert.deepEqual(wf.nodes[1]!.needs, ['one']);
  });

  test('an out list is shorthand for same-named world fields', () => {
    const wf = parseWorkflow(
      `name: s\nworld:\n  a: {type: json, merge: replace}\nnodes:\n  - {id: n, agent: worker, out: [a]}\n`,
      '<test>',
    );
    assert.deepEqual(wf.nodes[0]!.out, { a: 'a' });
  });

  test('writing an undeclared world field is rejected with a fixable message', () => {
    assert.throws(
      () =>
        parseWorkflow(
          `name: s\nworld:\n  a: {type: json, merge: replace}\nnodes:\n  - {id: n, agent: worker, out: [typo]}\n`,
          '<test>',
        ),
      /writes undeclared world field "typo"/,
    );
  });

  test('writing a field owned by another node is rejected at load time', () => {
    assert.throws(
      () =>
        parseWorkflow(
          `
name: s
world:
  a: { type: json, merge: replace, owner: one }
nodes:
  - { id: one, agent: worker, out: [a] }
  - { id: two, agent: worker, out: [a] }
`,
          '<test>',
        ),
      /owned by "one"/,
    );
  });

  test('dependency cycles are rejected', () => {
    assert.throws(
      () =>
        parseWorkflow(
          `
name: s
world:
  a: { type: json, merge: replace }
nodes:
  - { id: one, agent: worker, needs: [two], out: [a] }
  - { id: two, agent: worker, needs: [one] }
`,
          '<test>',
        ),
      (err: unknown) => {
        assert.ok(err instanceof SyncwConfigError);
        assert.match(err.message, /cycle/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// World wiring
// ---------------------------------------------------------------------------

describe('world wiring', () => {
  test('a single node writes its declared world field', async () => {
    const deps = depsFor(`
name: basic
world:
  result: { type: json, merge: replace }
nodes:
  - id: work
    agent: worker
    out: { result: note }
`);
    const { meta, world } = await runWorkflow(deps, { input: {} });

    assert.equal(meta.status, 'ok');
    assert.equal(typeof world['result'], 'string');
    // Which model wins under `balanced` is covered in binding.test.ts; here we
    // only care that the node was bound by policy and the world was written.
    assert.equal(typeof meta.bindings['work'], 'string');
    assert.equal(meta.nodes[0]!.bindingSource, 'policy');
    assert.equal(meta.nodes[0]!.cacheHits, 0);
  });

  test('a value mapped from a missing contract field is a loud error, not undefined', async () => {
    const deps = depsFor(`
name: badmap
world:
  result: { type: json, merge: replace }
nodes:
  - id: work
    agent: worker
    out: { result: not_a_declared_field }
`);
    const { meta } = await runWorkflow(deps, { input: {} });
    assert.equal(meta.status, 'failed');
    assert.match(meta.error ?? '', /has no such key/);
    assert.match(meta.error ?? '', /confidence, note/);
  });

  test('a false `when` guard skips the node and costs nothing', async () => {
    const deps = depsFor(`
name: guarded
world:
  result: { type: json, merge: replace }
  other: { type: json, merge: replace }
nodes:
  - id: first
    agent: worker
    out: { result: note }
  - id: gated
    kind: human_gate
    when: $.world.result == "definitely-not-the-value"
  - id: last
    agent: worker
    needs: [gated]
    out: { other: note }
`);
    const { meta } = await runWorkflow(deps, { input: {} });

    assert.equal(meta.status, 'ok');
    assert.equal(meta.nodes.find((n) => n.node === 'gated')!.status, 'skipped');
    assert.equal(meta.nodes.find((n) => n.node === 'gated')!.costUsd, 0);
    assert.equal(meta.nodes.find((n) => n.node === 'last')!.status, 'ok');
  });
});

// ---------------------------------------------------------------------------
// Fan-out and join
// ---------------------------------------------------------------------------

const FANOUT_WORLD = `
world:
  scores: { type: json, merge: append }
`;

function fanout(join: string): string {
  return `
name: fanout
${FANOUT_WORLD}
nodes:
  - id: work
    agent: worker
    for_each: $.input.items
    join: ${join}
    out: { scores: confidence }
`;
}

describe('fan-out and join', () => {
  test('join:all appends every item', async () => {
    const deps = depsFor(fanout('all'));
    const { meta, world } = await runWorkflow(deps, { input: { items: [1, 2, 3] } });

    assert.equal(meta.status, 'ok');
    assert.equal(meta.nodes[0]!.items, 3);
    assert.equal((world['scores'] as unknown[]).length, 3);
  });

  test('join:best_of(1) commits only the winning item', async () => {
    const all = await runWorkflow(depsFor(fanout('all')), { input: { items: [1, 2, 3] } });
    const best = await runWorkflow(depsFor(fanout('best_of(1)')), { input: { items: [1, 2, 3] } });

    const allScores = all.world['scores'] as number[];
    const bestScores = best.world['scores'] as number[];

    assert.equal(bestScores.length, 1, 'only the winner is written to the world');
    assert.equal(bestScores[0], Math.max(...allScores), 'and it is the highest self-reported confidence');
  });

  test('join:any survives a partial failure that join:all rejects', async () => {
    const yaml = (join: string): string => `
name: partial
world:
  scores: { type: json, merge: append }
nodes:
  - id: work
    agent: worker
    for_each: $.input.items
    join: ${join}
    bind:
      by_index: [mock/cheap, mock/premium]
    out: { scores: confidence }
`;
    // Fail the second vendor only: item 0 uses cheap, item 1 uses premium.
    const failing = ['mock/premium'];

    const strict = await runWorkflow(depsFor(yaml('all'), [CHEAP, PREMIUM], failing), {
      input: { items: [1, 2] },
    });
    assert.equal(strict.meta.status, 'failed');
    assert.match(strict.meta.error ?? '', /join=all/);

    const lenient = await runWorkflow(depsFor(yaml('any'), [CHEAP, PREMIUM], failing), {
      input: { items: [1, 2] },
    });
    assert.equal(lenient.meta.status, 'ok');
    assert.equal((lenient.world['scores'] as unknown[]).length, 1);

    // The failing node is still recorded with its cause, so `syncw show` can
    // explain a partial run rather than just reporting success.
    assert.equal(strict.meta.nodes[0]!.status, 'failed');
    assert.match(strict.meta.nodes[0]!.error ?? '', /mock failure injected/);
    assert.match(strict.meta.error ?? '', /First failure: mock failure injected/);
  });

  test('join:quorum(n) fails when fewer than n items succeed', async () => {
    const deps = depsFor(
      `
name: quorum
world:
  scores: { type: json, merge: append }
nodes:
  - id: work
    agent: worker
    for_each: $.input.items
    join: quorum(2)
    bind:
      by_index: [mock/cheap, mock/premium]
    out: { scores: confidence }
`,
      [CHEAP, PREMIUM],
      ['mock/premium'],
    );
    const { meta } = await runWorkflow(deps, { input: { items: [1, 2] } });
    assert.equal(meta.status, 'failed');
    assert.match(meta.error ?? '', /quorum\(2\): only 1 of 2/);
  });

  test('an unknown join policy is rejected rather than silently treated as all', async () => {
    const deps = depsFor(fanout('majority'));
    const { meta } = await runWorkflow(deps, { input: { items: [1] } });
    assert.equal(meta.status, 'failed');
    assert.match(meta.error ?? '', /unknown join policy "majority"/);
  });

  test('fanning out over an empty source is an actionable error', async () => {
    const deps = depsFor(fanout('all'));
    const { meta } = await runWorkflow(deps, { input: { items: undefined } });
    assert.equal(meta.status, 'failed');
    assert.match(meta.error ?? '', /fans out over/);
  });
});

// ---------------------------------------------------------------------------
// Recovery ordering: retry -> fallback -> escalate
// ---------------------------------------------------------------------------

function recoveryYaml(opts: { retries?: number; fallback?: string; escalate?: boolean }): string {
  const lines = [
    'name: recovery',
    'world:',
    '  result: { type: json, merge: replace }',
    'nodes:',
    '  - id: work',
    '    agent: worker',
  ];
  if (opts.retries !== undefined) lines.push(`    retries: ${opts.retries}`);
  lines.push('    bind:');
  lines.push('      prefer: cost');
  if (opts.fallback) lines.push(`      fallback: [${opts.fallback}]`);
  if (opts.escalate) lines.push('      escalate_if: { to: quality }');
  lines.push('    out: { result: note }');
  return lines.join('\n');
}

describe('recovery ordering', () => {
  test('retries re-bind to the next candidate and do NOT escalate', async () => {
    const deps = depsFor(recoveryYaml({ retries: 1, escalate: true }), [CHEAP, PREMIUM], ['mock/cheap']);
    const { meta, chronicle } = await runWorkflow(deps, { input: {} });

    assert.equal(meta.status, 'ok');
    assert.equal(meta.nodes[0]!.model, 'mock/premium');
    assert.equal(meta.nodes[0]!.attempts, 2);
    assert.equal(chronicle.events.some((e) => e.type === 'bind.escalate'), false);
    assert.equal(chronicle.events.some((e) => e.type === 'llm.error'), true);
  });

  test('escalation fires only after retries and fallback are spent', async () => {
    const deps = depsFor(recoveryYaml({ retries: 0, escalate: true }), [CHEAP, PREMIUM], ['mock/cheap']);
    const { meta, chronicle } = await runWorkflow(deps, { input: {} });

    assert.equal(meta.status, 'ok', meta.error);
    assert.equal(meta.nodes[0]!.model, 'mock/premium', 'escalated from cost to quality');
    assert.equal(meta.nodes[0]!.attempts, 2);

    const escalate = chronicle.events.find((e) => e.type === 'bind.escalate');
    assert.ok(escalate, 'a bind.escalate event must be recorded');
    assert.equal(escalate.data['from'], 'mock/cheap');
    assert.equal(escalate.data['to'], 'quality');
  });

  test('the fallback chain is used before escalation', async () => {
    // require makes nothing eligible, so the fallback is what saves the node.
    const deps = depsFor(
      `
name: fb
world:
  result: { type: json, merge: replace }
nodes:
  - id: work
    agent: worker
    bind:
      require: [json_schema, ctx>=999999]
      prefer: cost
      fallback: [mock/premium]
      escalate_if: { to: quality }
    out: { result: note }
`,
      [CHEAP, PREMIUM],
    );
    const { meta, chronicle } = await runWorkflow(deps, { input: {} });

    assert.equal(meta.status, 'ok', meta.error);
    assert.equal(meta.nodes[0]!.model, 'mock/premium');
    assert.equal(meta.nodes[0]!.bindingSource, 'fallback');
    assert.equal(chronicle.events.some((e) => e.type === 'bind.escalate'), false);
  });

  test('with no recovery declared at all, the failure is loud and immediate', async () => {
    const deps = depsFor(recoveryYaml({ retries: 0 }), [CHEAP, PREMIUM], ['mock/cheap']);
    const { meta } = await runWorkflow(deps, { input: {} });

    assert.equal(meta.status, 'failed');
    assert.match(meta.error ?? '', /mock failure injected/);
    assert.equal(meta.nodes[0]!.attempts, 1);
  });

  test('a failing provider never causes a silent switch to a forbidden lineage', async () => {
    // Nothing can satisfy ctx>=999999, so the node must go through the fallback
    // path - and the only fallback on offer is the forbidden lineage.
    const deps = depsFor(
      `
name: safefb
world:
  result: { type: json, merge: replace }
nodes:
  - id: work
    agent: worker
    retries: 1
    bind:
      require: [not_family_of:mock/cheap, ctx>=999999]
      prefer: cost
      fallback: [mock/cheap]
      escalate_if: { to: quality }
    out: { result: note }
`,
      [CHEAP, PREMIUM, THIRD],
    );
    const { meta } = await runWorkflow(deps, { input: {} });

    // The correct outcome is a loud failure. Quietly binding mock/cheap here
    // would be the single most dangerous behaviour this engine could have.
    assert.equal(meta.status, 'failed');
    assert.notEqual(meta.nodes[0]!.model, 'mock/cheap');
    assert.match(meta.error ?? '', /could not be bound/);
    assert.match(meta.error ?? '', /no model satisfied/);
  });
});

// ---------------------------------------------------------------------------
// Cross-lineage enforcement, end to end
// ---------------------------------------------------------------------------

describe('cross-lineage enforcement against runtime reality', () => {
  const yaml = `
name: crosslineage
world:
  notes: { type: json, merge: append }
  verdict: { type: json, merge: replace, owner: judge }
nodes:
  - id: produce
    agent: worker
    for_each: $.input.items
    bind:
      by_index: [mock/cheap, mock/third]
    out: { notes: note }

  - id: judge
    agent: worker
    needs: [produce]
    bind:
      require:
        - not_family_of:$.nodes.produce.actual_families
      prefer: quality
    in:
      notes: $.world.notes
    out: { verdict: note }
`;

  test('the judge is pushed outside every producing family', async () => {
    const deps = depsFor(yaml, [CHEAP, PREMIUM, THIRD]);
    const { meta } = await runWorkflow(deps, { input: { items: [1, 2] } });

    assert.equal(meta.status, 'ok', meta.error);
    const judge = meta.nodes.find((n) => n.node === 'judge')!;
    assert.equal(judge.model, 'mock/premium', 'the only model outside {cheap, third}');
  });

  test('the constraint tracks what actually ran, not what the workflow declared', async () => {
    // Pin the fan-out onto a single model. The judge must still be pushed out
    // of that family - a fan-out that collapsed is still a fan-out.
    const deps = depsFor(yaml, [CHEAP, PREMIUM, THIRD]);
    const { meta } = await runWorkflow(deps, {
      input: { items: [1, 2] },
      swaps: { produce: 'mock/third' },
    });

    assert.equal(meta.status, 'ok', meta.error);
    assert.equal(meta.nodes.find((n) => n.node === 'produce')!.model, 'mock/third');
    const judge = meta.nodes.find((n) => n.node === 'judge')!;
    assert.notEqual(judge.model, 'mock/third');
    assert.equal(judge.model, 'mock/premium');
  });
});

// ---------------------------------------------------------------------------
// Budget and cache
// ---------------------------------------------------------------------------

describe('budgets and caching', () => {
  test('a run budget halts execution and marks the run', async () => {
    const deps = depsFor(`
name: budget
budget: { max_usd: 0.0000001 }
world:
  result: { type: json, merge: replace }
nodes:
  - id: work
    agent: worker
    out: { result: note }
`);
    const { meta } = await runWorkflow(deps, { input: {} });
    assert.equal(meta.status, 'budget_exceeded');
    assert.match(meta.error ?? '', /workflow budget exceeded/);
  });

  test('a per-binding budget halts that node', async () => {
    const deps = depsFor(`
name: bindbudget
world:
  result: { type: json, merge: replace }
nodes:
  - id: work
    agent: worker
    bind: { max_usd: 0.0000001 }
    out: { result: note }
`);
    const { meta } = await runWorkflow(deps, { input: {} });
    assert.equal(meta.status, 'budget_exceeded');
    assert.match(meta.error ?? '', /exceeded its binding budget/);
  });

  test('re-running identical work is served from cache and costs nothing', async () => {
    const deps = depsFor(`
name: cached
world:
  result: { type: json, merge: replace }
nodes:
  - id: work
    agent: worker
    out: { result: note }
`);

    const first = await runWorkflow(deps, { input: {} });
    const second = await runWorkflow(deps, { input: {} });

    assert.equal(first.meta.totalCostUsd > 0, true);
    assert.equal(second.meta.totalCostUsd, 0, 'cache hit means no new spend');
    assert.equal(second.meta.nodes[0]!.cacheHits, 1);
    assert.deepEqual(second.world, first.world, 'and byte-identical world state');
  });

  test('a swapped model is a cache miss, so the diff is real', async () => {
    const yaml = `
name: swapcache
world:
  result: { type: json, merge: replace }
nodes:
  - id: work
    agent: worker
    out: { result: note }
`;
    const deps = depsFor(yaml);
    const base = await runWorkflow(deps, { input: {} });
    const swapped = await runWorkflow(deps, {
      input: {},
      swaps: { work: 'mock/premium' },
      replayOf: base.meta.runId,
    });

    assert.equal(swapped.meta.nodes[0]!.model, 'mock/premium');
    assert.equal(swapped.meta.nodes[0]!.cacheHits, 0, 'different model, different cache key');
    assert.equal(swapped.meta.replayOf, base.meta.runId);
    assert.equal(swapped.world['result'] !== base.world['result'], true);
  });
});
