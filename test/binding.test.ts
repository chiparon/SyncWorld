/**
 * The binding engine: resolution order, ranking, and - most importantly - the
 * guarantee that `fallback:` can degrade resources but never safety.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  BindingError,
  makeFamilyResolver,
  resolveBinding,
} from '../src/runtime/binding.ts';
import type { BindContext, ProviderAvailability } from '../src/runtime/binding.ts';
import type { EvalContext } from '../src/runtime/refs.ts';
import { World } from '../src/runtime/world.ts';
import type { ModelProfile } from '../src/schema/types.ts';

function model(
  id: string,
  family: string,
  ctx: number,
  cost: { in: number; out: number },
  quality: number,
  latencyP50Ms = 500,
  caps: ModelProfile['caps'] = ['json_schema'],
): ModelProfile {
  return { id, provider: 'mock', family, ctx, caps, cost, quality, latencyP50Ms };
}

// blended cost = in + 3*out  ->  alpha 10, beta 1, gamma 50
const MODELS: ModelProfile[] = [
  model('mock/alpha', 'alpha', 128_000, { in: 1, out: 3 }, 0.9),
  model('mock/beta', 'beta', 32_000, { in: 0.1, out: 0.3 }, 0.6),
  model('mock/gamma', 'gamma', 200_000, { in: 5, out: 15 }, 0.75),
];

const AVAILABLE: ProviderAvailability = { check: () => ({ ok: true, reason: 'test' }) };
const UNAVAILABLE: ProviderAvailability = {
  check: (_p, id) => ({ ok: false, reason: `needs a key for ${id}` }),
};

function evalCtx(nodes: Record<string, unknown> = {}): EvalContext {
  return {
    input: {},
    world: new World({}),
    nodes: new Map(Object.entries(nodes)) as EvalContext['nodes'],
  };
}

function bind(overrides: Partial<BindContext> = {}): ReturnType<typeof resolveBinding> {
  return resolveBinding({
    policy: {},
    models: MODELS,
    availability: AVAILABLE,
    evalCtx: evalCtx(),
    strict: true,
    resolveFamily: makeFamilyResolver(MODELS),
    ...overrides,
  });
}

describe('policy resolution: filter, then rank', () => {
  test('require filters before prefer ranks', () => {
    const d = bind({ policy: { require: ['json_schema', 'ctx>=64k'], prefer: 'quality' } });
    assert.equal(d.model?.id, 'mock/alpha');
    assert.equal(d.source, 'policy');
    // gamma also passes the filter; alpha wins on quality, not on cost.
    assert.match(d.reasons.join(' '), /beat mock\/gamma on quality/);
  });

  test('the same constraints with prefer:cost pick the other survivor', () => {
    const d = bind({ policy: { require: ['json_schema', 'ctx>=64k'], prefer: 'cost' } });
    assert.equal(d.model?.id, 'mock/alpha', 'gamma is 5x more expensive');
  });

  test('a looser filter changes the winner entirely', () => {
    const d = bind({ policy: { require: ['json_schema'], prefer: 'cost' } });
    assert.equal(d.model?.id, 'mock/beta', 'cheapest model in the registry');
  });

  test('every model is reported, winners and losers alike', () => {
    const d = bind({ policy: { require: ['ctx>=64k'] } });
    assert.equal(d.candidates.length, MODELS.length);
    const beta = d.candidates.find((c) => c.id === 'mock/beta')!;
    assert.equal(beta.ok, false);
    assert.match(beta.reasons.join(' '), /violates >=64k/);
  });

  test('ranking is deterministic: ties break on id, not on registry order', () => {
    const twins = [model('mock/z', 'z', 1000, { in: 1, out: 1 }, 0.5), model('mock/a', 'a', 1000, { in: 1, out: 1 }, 0.5)];
    const d = resolveBinding({
      policy: { prefer: 'quality' },
      models: twins,
      availability: AVAILABLE,
      evalCtx: evalCtx(),
      strict: true,
    });
    assert.equal(d.model?.id, 'mock/a');
  });
});

describe('nothing survives', () => {
  test('an over-constrained policy reports why, and says there is nowhere to go', () => {
    const d = bind({ policy: { require: ['ctx>=300k'] } });
    assert.equal(d.model, null);
    assert.match(d.reasons.join(' '), /no model satisfied/);
    assert.match(d.reasons.join(' '), /no `fallback:` declared/);
  });

  test('a rejected model states the specific constraint it broke', () => {
    const d = bind({ policy: { require: ['ctx>=300k'] } });
    for (const c of d.candidates) {
      assert.equal(c.ok, false);
      assert.match(c.reasons.join(' '), /violates >=300k/);
    }
  });
});

describe('explicit selection bypasses constraints, and says so', () => {
  test('pin overrides require', () => {
    const d = bind({ policy: { pin: 'mock/beta', require: ['ctx>=64k'] } });
    assert.equal(d.model?.id, 'mock/beta', 'beta violates ctx>=64k and is still chosen');
    assert.equal(d.source, 'pin');
    assert.match(d.reasons.join(' '), /constraints are intentionally NOT applied/);
  });

  test('by_index rotates across the fan-out and cycles past the end', () => {
    const policy = { byIndex: ['mock/alpha', 'mock/beta'] };
    assert.equal(bind({ policy, itemIndex: 0 }).model?.id, 'mock/alpha');
    assert.equal(bind({ policy, itemIndex: 1 }).model?.id, 'mock/beta');
    assert.equal(bind({ policy, itemIndex: 2 }).model?.id, 'mock/alpha');
    assert.equal(bind({ policy, itemIndex: 0 }).source, 'byIndex');
  });

  test('by_index is inert outside a fan-out, so the policy still applies', () => {
    const d = bind({ policy: { byIndex: ['mock/alpha'], prefer: 'cost' } });
    assert.equal(d.model?.id, 'mock/beta');
    assert.equal(d.source, 'policy');
  });

  test('an unmatched pin lists near misses instead of failing silently', () => {
    assert.throws(
      () => bind({ policy: { pin: 'mock/alph' } }),
      (err: unknown) => {
        assert.ok(err instanceof BindingError);
        assert.match(err.message, /no model matches "mock\/alph"/);
        assert.match(err.message, /did you mean: mock\/alpha/);
        return true;
      },
    );
  });

  test('an excluded pin fails loudly rather than falling back', () => {
    assert.throws(
      () => bind({ policy: { pin: 'mock/alpha' }, exclude: ['mock/alpha'] }),
      /none are usable/,
    );
  });
});

describe('fallback: safety is inviolable, resources are degradable', () => {
  test('unreachable RESOURCE constraints are relaxed to find a fallback', () => {
    const d = bind({
      policy: { require: ['ctx>=300k'], prefer: 'quality', fallback: ['mock/*'] },
    });
    assert.equal(d.source, 'fallback');
    assert.equal(d.model?.id, 'mock/alpha', 'the highest-quality model, ignoring ctx');
    assert.match(d.reasons.join(' '), /RESOURCE constraints were relaxed/);
    assert.match(d.reasons.join(' '), /SAFETY constraints still hold/);
  });

  test('SAFETY constraints survive the relaxation', () => {
    const d = bind({
      policy: {
        require: ['ctx>=300k', 'not_family_of:mock/alpha'],
        prefer: 'quality',
        fallback: ['mock/*'],
      },
    });
    assert.equal(d.source, 'fallback');
    assert.notEqual(d.model?.family, 'alpha', 'the excluded lineage must not come back');
    assert.equal(d.model?.id, 'mock/gamma');
  });

  test('a fallback pattern that would break safety is refused, not honoured', () => {
    const d = bind({
      policy: {
        require: ['not_family_of:mock/alpha', 'ctx>=300k'],
        prefer: 'quality',
        fallback: ['mock/alpha'],
      },
    });
    // Nothing satisfies the constraints, and the only fallback on offer is the
    // forbidden lineage. The correct answer is no answer - a loud failure beats
    // a quiet safety violation.
    assert.equal(d.model, null);
    assert.equal(d.candidates.some((c) => c.id === 'mock/alpha' && c.ok), false);
    assert.match(d.reasons.join(' '), /no `fallback:` pattern produced a usable model/);
    assert.match(d.reasons.join(' '), /safety constraints such as not_family_of/);
  });

  test('during recovery, a refused fallback re-resolves through the general policy', () => {
    // The excluded set has changed since the policy path ran, so re-evaluating
    // can now find something the first pass missed - while still refusing to
    // touch the forbidden lineage.
    const d = bind({
      policy: { require: ['not_family_of:mock/alpha'], prefer: 'quality', fallback: ['mock/alpha'] },
      exclude: ['mock/beta'],
      forceFallback: true,
    });
    assert.equal(d.model?.id, 'mock/gamma');
    assert.notEqual(d.model?.family, 'alpha');
    assert.match(d.reasons.join(' '), /could not be honoured without violating a SAFETY/);
  });

  test('a safety-only failure never silently picks the forbidden model', () => {
    for (const fallback of [['mock/alpha'], ['mock/a*'], ['mock/alpha', 'mock/alpha']]) {
      const d = bind({
        policy: { require: ['not_family_of:mock/alpha'], fallback, prefer: 'quality' },
      });
      assert.notEqual(d.model?.family, 'alpha', `fallback ${fallback.join(',')} leaked a safety violation`);
    }
  });

  test('fallback patterns are tried in declaration order', () => {
    const d = bind({
      policy: { require: ['ctx>=300k'], prefer: 'quality', fallback: ['mock/gamma', 'mock/*'] },
    });
    assert.equal(d.model?.id, 'mock/gamma', 'the first matching pattern wins');
  });

  test('unmatched patterns are reported with the reason they failed', () => {
    const d = bind({
      policy: { require: ['ctx>=300k'], prefer: 'quality', fallback: ['nope/*'] },
    });
    assert.equal(d.model, null);
    assert.match(d.reasons.join(' '), /no `fallback:` pattern produced a usable model/);
  });
});

describe('exclusion drives re-binding after a failure', () => {
  test('the failed model is skipped and the next candidate wins', () => {
    const first = bind({ policy: { require: ['json_schema'], prefer: 'cost' } });
    assert.equal(first.model?.id, 'mock/beta');

    const second = bind({
      policy: { require: ['json_schema'], prefer: 'cost' },
      exclude: ['mock/beta'],
    });
    assert.equal(second.model?.id, 'mock/alpha');
    assert.match(
      second.candidates.find((c) => c.id === 'mock/beta')!.reasons.join(' '),
      /already attempted and failed/,
    );
  });

  test('when the exclusions run out the result is null, not a repeat attempt', () => {
    const d = bind({
      policy: { require: ['json_schema'], prefer: 'cost' },
      exclude: ['mock/beta', 'mock/alpha', 'mock/gamma'],
    });
    assert.equal(d.model, null);
  });
});

describe('escalation re-ranks without changing the constraints', () => {
  test('preferOverride wins over the declared prefer', () => {
    const declared = bind({ policy: { require: ['json_schema'], prefer: 'cost' } });
    assert.equal(declared.model?.id, 'mock/beta');

    const escalated = bind({
      policy: { require: ['json_schema'], prefer: 'cost' },
      preferOverride: 'quality',
    });
    assert.equal(escalated.model?.id, 'mock/alpha');
    assert.equal(escalated.source, 'escalation');
    assert.match(escalated.reasons.join(' '), /escalated from cost/);
  });
});

describe('credential availability is a candidate property, not a crash', () => {
  test('an unreachable provider removes every one of its models', () => {
    const d = bind({ policy: { require: ['json_schema'] }, availability: UNAVAILABLE });
    assert.equal(d.model, null);
    assert.match(d.candidates[0]!.reasons.join(' '), /needs a key for/);
  });

  test('preview mode keeps them selectable and labels them', () => {
    const d = bind({
      policy: { require: ['json_schema'], prefer: 'cost' },
      availability: UNAVAILABLE,
      allowUnavailable: true,
    });
    assert.equal(d.model?.id, 'mock/beta');
    assert.match(d.candidates[0]!.reasons.join(' '), /preview mode: still selectable/);
  });
});
