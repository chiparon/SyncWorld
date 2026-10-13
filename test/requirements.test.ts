/**
 * The constraint language, and the safety/resource split that makes
 * `fallback:` safe to use.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  RequirementSyntaxError,
  familyOf,
  parseRequirement,
  parseRequirements,
  safetyOnly,
} from '../src/runtime/requirements.ts';
import type { EvalContext } from '../src/runtime/refs.ts';
import { World } from '../src/runtime/world.ts';
import type { ModelProfile } from '../src/schema/types.ts';

const MODELS: ModelProfile[] = [
  model('mock/alpha', 'alpha', 128_000, { in: 1, out: 3 }, 0.9),
  model('mock/beta', 'beta', 32_000, { in: 0.1, out: 0.3 }, 0.6),
  model('mock/gamma', 'gamma', 200_000, { in: 5, out: 15 }, 0.75),
];

function model(
  id: string,
  family: string,
  ctx: number,
  cost: { in: number; out: number },
  quality: number,
): ModelProfile {
  return { id, provider: 'mock', family, ctx, caps: ['json_schema'], cost, quality };
}

function ctx(nodes: Record<string, unknown> = {}): EvalContext {
  return {
    input: {},
    world: new World({}),
    nodes: new Map(Object.entries(nodes)) as EvalContext['nodes'],
  };
}

const a = MODELS[0]!;
const b = MODELS[1]!;
const g = MODELS[2]!;

describe('classification: what fallback may and may not relax', () => {
  test('capability and numeric constraints are resources', () => {
    for (const raw of ['json_schema', 'ctx>=128k', 'cost_in<=3', 'quality>=0.8', 'latency<=2000']) {
      assert.equal(parseRequirement(raw).kind, 'resource', raw);
    }
  });

  test('lineage and provider constraints are safety', () => {
    for (const raw of [
      'not_family_of:mock/alpha',
      'not_same_as:$.nodes.x.actual_model',
      'provider:mock',
      'family!=alpha',
    ]) {
      assert.equal(parseRequirement(raw).kind, 'safety', raw);
    }
  });

  test('safetyOnly keeps exactly the safety constraints', () => {
    const reqs = parseRequirements(['json_schema', 'ctx>=128k', 'not_family_of:mock/alpha']);
    assert.deepEqual(
      safetyOnly(reqs).map((r) => r.raw),
      ['not_family_of:mock/alpha'],
    );
  });
});

describe('numeric requirements', () => {
  test('k and m suffixes expand', () => {
    const t = parseRequirement('ctx>=128k');
    assert.equal(t.test(a, ctx(), true).ok, true);
    assert.equal(t.test(b, ctx(), true).ok, false);
  });

  test('the boundary is inclusive', () => {
    assert.equal(parseRequirement('ctx>=128000').test(a, ctx(), true).ok, true);
    assert.equal(parseRequirement('ctx>128000').test(a, ctx(), true).ok, false);
  });

  test('cost and quality compare against the profile', () => {
    assert.equal(parseRequirement('cost_out<=3').test(a, ctx(), true).ok, true);
    assert.equal(parseRequirement('cost_out<=3').test(g, ctx(), true).ok, false);
    assert.equal(parseRequirement('quality>=0.8').test(a, ctx(), true).ok, true);
    assert.equal(parseRequirement('quality>=0.8').test(b, ctx(), true).ok, false);
  });

  test('a model without the measured field fails rather than passing by default', () => {
    const noLatency: ModelProfile = { ...a, latencyP50Ms: undefined };
    const result = parseRequirement('latency<=2000').test(noLatency, ctx(), true);
    assert.equal(result.ok, false);
    assert.match(result.reason, /unknown/);
  });

  test('an unknown numeric field is a syntax error, not a silent pass', () => {
    assert.throws(() => parseRequirement('context>=1k'), RequirementSyntaxError);
  });
});

describe('capability requirements', () => {
  test('presence and absence', () => {
    const gammaNoCaps: ModelProfile = { ...g, caps: [] };
    assert.equal(parseRequirement('json_schema').test(gammaNoCaps, ctx(), true).ok, false);
    assert.equal(parseRequirement('json_schema').test(a, ctx(), true).ok, true);
  });
});

describe('cross-lineage independence', () => {
  test('a literal target resolves through the registry, not string guessing', () => {
    const req = parseRequirement('not_family_of:mock/alpha');
    const resolveFamily = (id: string): string | undefined =>
      MODELS.find((m) => m.id === id)?.family;

    assert.equal(req.test(a, ctx(), true, resolveFamily).ok, false);
    assert.equal(req.test(b, ctx(), true, resolveFamily).ok, true);
  });

  test('a list target rejects every family in it', () => {
    const req = parseRequirement('not_family_of:$.nodes.producer.actual_families');
    const c = ctx({ producer: { actual_families: ['alpha', 'beta'] } });

    assert.equal(req.test(a, c, true).ok, false, 'alpha is a producer');
    assert.equal(req.test(b, c, true).ok, false, 'beta is a producer');
    assert.equal(req.test(g, c, true).ok, true, 'gamma is independent');
  });

  test('an unresolved reference defers when not strict, throws when strict', () => {
    const req = parseRequirement('not_family_of:$.nodes.missing.actual_model');
    const c = ctx();

    const deferred = req.test(a, c, false);
    assert.equal(deferred.ok, true);
    assert.equal(deferred.deferred, true);

    assert.throws(() => req.test(a, c, true), /not available yet/);
  });

  test('a vacuous target is satisfied, not silently rejected', () => {
    const req = parseRequirement('not_family_of:$.nodes.producer.actual_model');
    const c = ctx({ producer: { actual_model: undefined } });
    const result = req.test(a, c, true);
    assert.equal(result.ok, true);
    assert.match(result.reason, /vacuous/);
  });

  test('not_same_as excludes exactly one model id', () => {
    const req = parseRequirement('not_same_as:mock/alpha');
    assert.equal(req.test(a, ctx(), true).ok, false);
    assert.equal(req.test(b, ctx(), true).ok, true);
  });
});

describe('familyOf heuristic (registry is the authority, this is the fallback)', () => {
  test('strips vendor prefixes, separators and trailing version digits', () => {
    assert.equal(familyOf('anthropic/claude-sonnet-4-5'), 'claude');
    assert.equal(familyOf('openai/gpt-5-mini'), 'gpt');
    assert.equal(familyOf('ollama/llama4-maverick'), 'llama');
    assert.equal(familyOf('ollama/qwen3-235b'), 'qwen');
    assert.equal(familyOf('deepseek/deepseek-v3-2'), 'deepseek');
    assert.equal(familyOf('google/gemini-2-5-pro'), 'gemini');
  });
});
