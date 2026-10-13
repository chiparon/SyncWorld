/**
 * The binding engine: the component that does not exist in any other framework.
 *
 * Input : a *query over model space* (BindPolicy) + the current world state.
 * Output: a concrete model, plus a complete, auditable account of why.
 *
 * Resolution order:
 *   1. `pin`       - absolute human override. Deliberately bypasses `require:`,
 *                    and says so in the trace, because a pin that silently
 *                    obeys constraints is a pin you cannot use to debug.
 *   2. `by_index`  - heterogeneous fan-out, one vendor per item. Also explicit,
 *                    also bypasses constraints.
 *   3. `require`/`prefer` - the normal path: filter, then rank.
 *   4. `fallback`  - glob patterns tried in order. Respects SAFETY constraints
 *                    and may relax RESOURCE ones. See requirements.ts for why
 *                    that line exists.
 *
 * Every model in the registry is evaluated and reported, including the ones
 * that lost. A binding decision you cannot audit is a binding decision you
 * cannot trust with production traffic.
 */

import type { BindPolicy, BindingDecision, CandidateReport, ModelProfile } from '../schema/types.ts';
import type { EvalContext } from './refs.ts';
import { RefError } from './refs.ts';
import { parseRequirements, safetyOnly } from './requirements.ts';
import type { Requirement } from './requirements.ts';
import { findMatches, globMatch, isExact } from '../util/glob.ts';

export type Prefer = NonNullable<BindPolicy['prefer']>;

export interface ProviderAvailability {
  check(provider: string, modelId: string): { ok: boolean; reason: string };
}

export class BindingError extends Error {
  readonly nodeId: string | undefined;

  constructor(message: string, nodeId?: string) {
    super(message);
    this.name = 'BindingError';
    this.nodeId = nodeId;
  }
}

export interface BindContext {
  policy: BindPolicy | undefined;
  models: readonly ModelProfile[];
  availability: ProviderAvailability;
  evalCtx: EvalContext;
  /** Present during fan-out; enables `by_index`. */
  itemIndex?: number;
  /**
   * Runtime mode. In strict mode a constraint that cannot be evaluated yet is
   * a hard failure rather than a deferred note.
   */
  strict: boolean;
  /** Overrides `policy.prefer` - used by escalation. */
  preferOverride?: Prefer;
  /** Model ids to skip - the ones that just failed. */
  exclude?: readonly string[];
  /** When true, models whose provider lacks credentials are still selectable. */
  allowUnavailable?: boolean;
  /**
   * Skip the normal policy path and go straight to `fallback:`. Set by the
   * engine after a runtime failure, so that `fallback:` means what its name
   * says: "when the primary choice does not work, go here instead".
   */
  forceFallback?: boolean;
  /** Authoritative lineage lookup; forwarded to requirement evaluation. */
  resolveFamily?: (modelId: string) => string | undefined;
  nodeId?: string;
}

export function resolveBinding(ctx: BindContext): BindingDecision {
  const policy = ctx.policy ?? {};
  const exclude = new Set(ctx.exclude ?? []);
  const allowUnavailable = ctx.allowUnavailable ?? false;

  if (policy.pin) {
    return byPattern(ctx, policy.pin, 'pin', exclude, allowUnavailable);
  }

  if (policy.byIndex && policy.byIndex.length > 0 && ctx.itemIndex !== undefined) {
    const pattern = policy.byIndex[ctx.itemIndex % policy.byIndex.length]!;
    const decision = byPattern(ctx, pattern, 'byIndex', exclude, allowUnavailable);
    decision.reasons.unshift(
      `by_index[${ctx.itemIndex}] -> "${pattern}" (item ${ctx.itemIndex} of the fan-out)`,
    );
    return decision;
  }

  const prefer: Prefer = ctx.preferOverride ?? policy.prefer ?? 'balanced';
  const requirements = parseRequirements(policy.require);
  const safety = safetyOnly(requirements);

  let fallbackExhausted = false;

  if (ctx.forceFallback && policy.fallback?.length) {
    const forced = tryFallbacks(
      ctx,
      policy.fallback,
      safety,
      requirements,
      prefer,
      exclude,
      allowUnavailable,
    );
    if (forced) {
      forced.reasons.unshift('recovery: forcing the declared `fallback:` chain after a failure');
      return forced;
    }
    // Every pattern either matched nothing or matched only models that safety
    // constraints forbid. Fall through to the general policy - which still
    // enforces safety - and say so, because a silent substitution here would
    // look like the fallback chain had been honoured when it had not.
    fallbackExhausted = true;
  }

  const { candidates, survivors } = evaluateAll(ctx, requirements, exclude, allowUnavailable, prefer);

  if (survivors.length > 0) {
    survivors.sort((a, b) => {
      const ds = (b.report.score ?? 0) - (a.report.score ?? 0);
      if (ds !== 0) return ds;
      return a.model.id.localeCompare(b.model.id); // deterministic tie-break
    });

    const winner = survivors[0]!;
    const reasons: string[] = [];
    if (fallbackExhausted) {
      reasons.push(
        `declared \`fallback:\` [${policy.fallback!.join(', ')}] could not be honoured without ` +
          `violating a SAFETY constraint, so the general policy was re-resolved instead`,
      );
    }
    reasons.push(
      `selected by policy: prefer=${prefer}` +
        (ctx.preferOverride ? ` (escalated from ${policy.prefer ?? 'balanced'})` : ''),
    );
    if (policy.require?.length) reasons.push(`constraints: ${policy.require.join(' AND ')}`);
    reasons.push(`${survivors.length}/${ctx.models.length} models satisfied the constraints`);
    if (survivors.length > 1) {
      const runnerUp = survivors[1]!;
      reasons.push(
        `beat ${runnerUp.model.id} on ${prefer} score ` +
          `(${fmt(winner.report.score ?? 0)} vs ${fmt(runnerUp.report.score ?? 0)})`,
      );
    }

    return {
      model: winner.model,
      source: ctx.preferOverride ? 'escalation' : 'policy',
      candidates,
      reasons,
    };
  }

  if (policy.fallback?.length) {
    const decision = tryFallbacks(
      ctx,
      policy.fallback,
      safety,
      requirements,
      prefer,
      exclude,
      allowUnavailable,
    );
    if (decision) {
      decision.candidates = mergeCandidates(candidates, decision.candidates);
      decision.reasons.unshift(
        `nothing satisfied [${(policy.require ?? []).join(' AND ') || 'no constraints'}] - ` +
          `fell through to \`fallback:\``,
      );
      return decision;
    }
  }

  return {
    model: null,
    source: ctx.preferOverride ? 'escalation' : 'policy',
    candidates,
    reasons: [
      `no model satisfied: ${(policy.require ?? []).join(' AND ') || '(no constraints declared)'}`,
      ...(policy.fallback?.length
        ? [
            `and no \`fallback:\` pattern produced a usable model: ${policy.fallback.join(', ')}`,
            `(fallback keeps safety constraints such as not_family_of, and may relax ` +
              `resource constraints such as ctx/cost/quality)`,
          ]
        : ['no `fallback:` declared, so there is nowhere left to go']),
    ],
  };
}

// ---------------------------------------------------------------------------
// Candidate evaluation - shared by the policy path and the fallback path
// ---------------------------------------------------------------------------

interface Evaluated {
  model: ModelProfile;
  report: CandidateReport;
}

function evaluateAll(
  ctx: BindContext,
  requirements: readonly Requirement[],
  exclude: ReadonlySet<string>,
  allowUnavailable: boolean,
  prefer: Prefer,
): { candidates: CandidateReport[]; survivors: Evaluated[] } {
  const candidates: CandidateReport[] = [];
  const survivors: Evaluated[] = [];

  for (const model of ctx.models) {
    const report = evaluateOne(model, requirements, ctx, exclude, allowUnavailable);
    if (report.ok) {
      report.score = score(model, prefer, ctx.models);
      survivors.push({ model, report });
    }
    candidates.push(report);
  }

  return { candidates, survivors };
}

function evaluateOne(
  model: ModelProfile,
  requirements: readonly Requirement[],
  ctx: BindContext,
  exclude: ReadonlySet<string>,
  allowUnavailable: boolean,
): CandidateReport {
  const report: CandidateReport = { id: model.id, ok: true, reasons: [] };

  if (exclude.has(model.id)) {
    report.ok = false;
    report.reasons.push('excluded: already attempted and failed');
  }

  let deferred = false;
  for (const req of requirements) {
    let result;
    try {
      result = req.test(model, ctx.evalCtx, ctx.strict, ctx.resolveFamily);
    } catch (err) {
      // A dangling reference is a *workflow* bug, not a reason to reject a
      // candidate. Swallowing it would report "no model satisfied the
      // constraints" when the real problem is a typo in a ref - the single
      // most misleading failure mode this engine could have.
      if (err instanceof RefError) throw err;
      result = { ok: false, reason: (err as Error).message };
    }
    if (!result.ok) {
      report.ok = false;
      report.reasons.push(result.reason);
    } else if (result.deferred) {
      deferred = true;
      report.reasons.push(result.reason);
    }
  }

  if (ctx.strict && deferred) {
    report.ok = false;
    report.reasons.push('deferred constraint could not be resolved at execution time');
  }

  if (report.ok) {
    const avail = ctx.availability.check(model.provider, model.id);
    if (!avail.ok && !allowUnavailable) {
      report.ok = false;
      report.reasons.push(avail.reason);
    } else if (!avail.ok) {
      report.reasons.push(`${avail.reason} (preview mode: still selectable)`);
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// Explicit selection (pin / by_index)
// ---------------------------------------------------------------------------

function byPattern(
  ctx: BindContext,
  pattern: string,
  source: BindingDecision['source'],
  exclude: ReadonlySet<string>,
  allowUnavailable: boolean,
): BindingDecision {
  const ids = ctx.models.map((m) => m.id);
  const matched = isExact(pattern) ? (ids.includes(pattern) ? [pattern] : []) : findMatches(pattern, ids);

  if (matched.length === 0) {
    throw new BindingError(
      `no model matches "${pattern}"${suggest(pattern, ids)}. ` +
        `Run \`syncw models\` to list the capability registry.`,
      ctx.nodeId,
    );
  }

  const candidates: CandidateReport[] = matched.map((id) => {
    const model = ctx.models.find((m) => m.id === id)!;
    const report: CandidateReport = { id, ok: true, reasons: [`matches "${pattern}"`] };
    if (exclude.has(id)) {
      report.ok = false;
      report.reasons.push('excluded: already attempted and failed');
      return report;
    }
    const avail = ctx.availability.check(model.provider, id);
    if (!avail.ok && !allowUnavailable) {
      report.ok = false;
      report.reasons.push(avail.reason);
    }
    return report;
  });

  const winner = candidates.find((c) => c.ok);
  if (!winner) {
    const detail = candidates
      .filter((c) => !c.ok)
      .flatMap((c) => c.reasons.filter((r) => !r.startsWith('matches "')))
      .join('; ');
    throw new BindingError(
      `"${pattern}" matched ${matched.join(', ')}, but none are usable: ${detail}`,
      ctx.nodeId,
    );
  }

  const reasons = [
    `${source} "${pattern}" -> ${winner.id}`,
    'explicit selection: `require:` constraints are intentionally NOT applied here',
  ];

  return {
    model: ctx.models.find((m) => m.id === winner.id)!,
    source,
    candidates,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Fallback chain
// ---------------------------------------------------------------------------

/**
 * `fallback:` is evaluated against SAFETY constraints only.
 *
 * The winning model must satisfy every `not_family_of` / `family` / `provider`
 * constraint; it does not have to satisfy `ctx>=200k` or `quality>=0.8`.
 * That way a fallback can degrade gracefully without ever producing a result
 * that is structurally untrustworthy - which is the only kind of degradation
 * worth automating.
 */
function tryFallbacks(
  ctx: BindContext,
  patterns: readonly string[],
  safety: readonly Requirement[],
  all: readonly Requirement[],
  prefer: Prefer,
  exclude: ReadonlySet<string>,
  allowUnavailable: boolean,
): BindingDecision | null {
  const attempts: CandidateReport[] = [];

  // Evaluate safety constraints once against the whole registry.
  const safetySurvivors = ctx.models.filter((m) => {
    const r = evaluateOne(m, safety, ctx, exclude, allowUnavailable);
    return r.ok;
  });

  for (const pattern of patterns) {
    const matching = safetySurvivors.filter((m) => globMatch(pattern, m.id));
    if (matching.length === 0) {
      const blocked = ctx.models.filter((m) => globMatch(pattern, m.id)).map((m) => m.id);
      attempts.push({
        id: pattern,
        ok: false,
        reasons: [
          blocked.length === 0
            ? 'no model id matches this pattern'
            : `matched ${blocked.join(', ')}, but all were rejected by safety constraints ` +
              `(${describeSafetyFailures(blocked, safety, ctx, exclude)})`,
        ],
      });
      continue;
    }

    const relaxed = matching.filter((m) => {
      const r = evaluateOne(m, all, ctx, exclude, allowUnavailable);
      return r.ok;
    });
    const pool = relaxed.length > 0 ? relaxed : matching;

    const ranked = pool
      .map((m) => ({ model: m, s: score(m, prefer, ctx.models) }))
      .sort((a, b) => (b.s !== a.s ? b.s - a.s : a.model.id.localeCompare(b.model.id)));

    const winner = ranked[0]!;
    const degraded = relaxed.length === 0;

    const candidates: CandidateReport[] = pool.map((m) => ({
      id: m.id,
      ok: m.id === winner.model.id,
      reasons: [`matches fallback "${pattern}"`],
      score: score(m, prefer, ctx.models),
    }));

    return {
      model: winner.model,
      source: 'fallback',
      candidates: mergeCandidates(attempts, candidates),
      reasons: [
        `fallback pattern "${pattern}" -> ${winner.model.id}`,
        degraded
          ? 'RESOURCE constraints were relaxed to find this model; SAFETY constraints still hold'
          : 'safety and resource constraints both satisfied',
        `not attempted: ${patterns
          .slice(0, patterns.indexOf(pattern))
          .filter((p) => p !== pattern)
          .join(', ') || '(none)'}`,
      ],
    };
  }

  return null;
}

function describeSafetyFailures(
  ids: readonly string[],
  safety: readonly Requirement[],
  ctx: BindContext,
  exclude: ReadonlySet<string>,
): string {
  for (const id of ids) {
    const model = ctx.models.find((m) => m.id === id);
    if (!model) continue;
    const r = evaluateOne(model, safety, ctx, exclude, true);
    if (!r.ok && r.reasons.length > 0) return r.reasons.join('; ');
  }
  return 'unknown';
}

function mergeCandidates(a: readonly CandidateReport[], b: readonly CandidateReport[]): CandidateReport[] {
  const byId = new Map<string, CandidateReport>();
  for (const c of [...a, ...b]) {
    const existing = byId.get(c.id);
    if (!existing || (!existing.ok && c.ok)) byId.set(c.id, c);
  }
  return [...byId.values()];
}

function suggest(pattern: string, ids: readonly string[]): string {
  const tokens = pattern.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  const near = ids.filter((id) => tokens.some((t) => id.toLowerCase().includes(t)));
  if (near.length === 0) return '';
  return ` (did you mean: ${near.slice(0, 3).join(', ')}?)`;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * A deterministic 0..1 score. Cost and latency are min-max normalised across
 * the candidate pool, so `prefer: cost` behaves sensibly whether the pool is
 * three frontier models or three local ones.
 */
export function score(model: ModelProfile, prefer: Prefer, pool: readonly ModelProfile[]): number {
  const q = clamp01(model.quality ?? 0.5);
  const costs = pool.map(blendedCost);
  const latencies = pool.map((m) => m.latencyP50Ms ?? 1500);
  const c = normalise(blendedCost(model), costs);
  const l = normalise(model.latencyP50Ms ?? median(latencies), latencies);

  switch (prefer) {
    case 'cost':
      return 1 - c;
    case 'quality':
      return q;
    case 'latency':
      return 1 - l;
    case 'balanced':
    default:
      return 0.5 * q + 0.3 * (1 - c) + 0.2 * (1 - l);
  }
}

function blendedCost(m: ModelProfile): number {
  // A typical agent turn reads far more than it writes; weight output ~3x.
  return m.cost.in * 1 + m.cost.out * 3;
}

function normalise(value: number, all: readonly number[]): number {
  const finite = all.filter((n) => Number.isFinite(n));
  if (finite.length === 0) return 0.5;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  if (max === min) return 0;
  return clamp01((value - min) / (max - min));
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function median(values: readonly number[]): number {
  const s = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (s.length === 0) return 1500;
  return s[Math.floor(s.length / 2)]!;
}

function fmt(n: number): string {
  return n.toFixed(3);
}

/** Convenience: does any pattern in the list match this model id? */
export function matchesAny(patterns: readonly string[], modelId: string): boolean {
  return patterns.some((p) => globMatch(p, modelId));
}

/**
 * Lineage lookup backed by the model registry. This is what makes
 * `not_family_of: $.nodes.x.actual_model` correct for models whose family is
 * not guessable from the id.
 */
export function makeFamilyResolver(
  models: readonly ModelProfile[],
): (modelId: string) => string | undefined {
  const byId = new Map(models.map((m) => [m.id, m.family]));
  return (modelId) => byId.get(modelId);
}
