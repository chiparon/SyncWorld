/**
 * Requirement expressions - the constraint language for binding policies.
 *
 *   ctx>=128k              minimum context window
 *   json_schema            capability must be present
 *   provider:anthropic     provider equality
 *   family!=claude         lineage exclusion
 *   not_family_of:$.nodes.implement.actual_model   cross-model independence
 *   cost_in<=3             USD per Mtok ceiling
 *   quality>=0.8           static prior (M3 replaces this with eval history)
 *   latency<=2000          p50 ms ceiling
 *
 * `not_family_of:` is the reason Syncw exists. Same-family self-review is
 * systematically over-confident, so "the verifier must not share a family with
 * whatever the producer actually ran on" has to be expressible in the workflow
 * file - and it has to keep working when the producer's model was picked at
 * runtime by policy.
 */

import type { Capability, ModelProfile } from '../schema/types.ts';
import { isRef, resolveRef } from './refs.ts';
import type { EvalContext } from './refs.ts';

export interface RequirementResult {
  ok: boolean;
  reason: string;
  /**
   * True when the constraint references runtime state that does not exist yet
   * (e.g. a dry run asking about a node that has not executed). Deferred
   * constraints are reported, never silently satisfied: at execution time
   * `strict` mode turns a deferred constraint into a hard failure.
   */
  deferred?: boolean;
}

/**
 * The line that makes `fallback:` safe to use.
 *
 * SAFETY constraints exist to stop the system producing a result that *looks*
 * fine but is structurally untrustworthy - chiefly same-lineage self-review.
 * They are never relaxed, not even when a node is failing and the operator
 * wants the run to finish.
 *
 * RESOURCE constraints express a budget or capability preference. Under
 * pressure they may degrade: a smaller context window or a pricier model is a
 * worse outcome, not a wrong one.
 *
 * So `fallback:` degrades resources and preserves safety, automatically.
 * Getting this wrong is the difference between "graceful degradation" and
 * "silently shipped a self-graded review".
 */
export type RequirementKind = 'safety' | 'resource';

export interface Requirement {
  raw: string;
  kind: RequirementKind;
  test(
    model: ModelProfile,
    evalCtx: EvalContext,
    strict: boolean,
    /**
     * Authoritative lineage lookup from the model registry. Falls back to
     * `familyOf` string heuristics only when the id is unknown to the registry.
     */
    familyResolver?: (modelId: string) => string | undefined,
  ): RequirementResult;
}

export class RequirementSyntaxError extends Error {
  constructor(raw: string, hint: string) {
    super(`cannot parse requirement "${raw}": ${hint}`);
    this.name = 'RequirementSyntaxError';
  }
}

const CAPABILITIES: readonly Capability[] = [
  'native_tool_calls',
  'parallel_tool_calls',
  'json_schema',
  'reasoning',
  'vision',
  'prompt_caching',
];

const NUMERIC_FIELDS: Record<string, (m: ModelProfile) => number | undefined> = {
  ctx: (m) => m.ctx,
  cost_in: (m) => m.cost.in,
  cost_out: (m) => m.cost.out,
  quality: (m) => m.quality,
  latency: (m) => m.latencyP50Ms,
  max_out: (m) => m.maxOut,
};

export function parseRequirement(raw: string): Requirement {
  const text = raw.trim();
  if (text === '') throw new RequirementSyntaxError(raw, 'empty');

  // Capability presence: bare identifier.
  if (CAPABILITIES.includes(text as Capability)) {
    return {
      raw: text,
      kind: 'resource',
      test: (m) =>
        m.caps.includes(text as Capability)
          ? { ok: true, reason: `has ${text}` }
          : { ok: false, reason: `missing capability ${text}` },
    };
  }

  // not_family_of:<ref>  |  not_same_as:<ref>
  const independence = /^(not_family_of|not_same_as)\s*:\s*(.+)$/.exec(text);
  if (independence) {
    const [, kind, refExpr] = independence as unknown as [string, string, string];
    return {
      raw: text,
      kind: 'safety',
      test: (m, evalCtx, strict, familyResolver) => {
        const target = resolveIndependenceTargets(refExpr, evalCtx, strict, familyResolver);
        if (target.deferred) {
          return {
            ok: true,
            reason: `${kind}(${refExpr}) deferred - target has not executed yet`,
            deferred: true,
          };
        }
        if (target.ids.length === 0) {
          return { ok: true, reason: `${kind}(${refExpr}) vacuous - no target models recorded` };
        }
        const joined = target.ids.join(', ');
        if (kind === 'not_same_as') {
          return target.ids.includes(m.id)
            ? { ok: false, reason: `is the same model as ${joined}` }
            : { ok: true, reason: `differs from ${joined}` };
        }
        // `not_family_of` is vacuously satisfied across a whole heterogeneous
        // fan-out only when NO producer shares this model's lineage.
        const clash = target.families.filter((f) => f === m.family);
        return clash.length > 0
          ? {
              ok: false,
              reason: `shares family "${m.family}" with ${joined} - self-review bias`,
            }
          : { ok: true, reason: `family "${m.family}" is independent of ${joined}` };
      },
    };
  }

  // provider: / family: equality or inequality
  const named = /^(provider|family)\s*(==|!=|:)\s*(.+)$/.exec(text);
  if (named) {
    const [, field, op, value] = named as unknown as [string, string, string, string];
    const negate = op === '!=';
    const want = value.trim();
    return {
      raw: text,
      kind: 'safety',
      test: (m) => {
        const actual = field === 'provider' ? m.provider : m.family;
        const equal = actual === want;
        return negate
          ? equal
            ? { ok: false, reason: `${field} is "${actual}", excluded` }
            : { ok: true, reason: `${field} "${actual}" != "${want}"` }
          : equal
            ? { ok: true, reason: `${field} is "${actual}"` }
            : { ok: false, reason: `${field} is "${actual}", need "${want}"` };
      },
    };
  }

  // Numeric comparison: ctx>=128k, cost_in<=3, quality>=0.8, latency<=2000
  const numeric = /^([a-z_]+)\s*(<=|>=|<|>|==|!=)\s*(.+)$/.exec(text);
  if (numeric) {
    const [, field, op, rawValue] = numeric as unknown as [string, string, string, string];
    const accessor = NUMERIC_FIELDS[field];
    if (!accessor) {
      throw new RequirementSyntaxError(
        raw,
        `unknown numeric field "${field}". Known: ${Object.keys(NUMERIC_FIELDS).join(', ')}`,
      );
    }
    const want = parseQuantity(rawValue);
    return {
      raw: text,
      kind: 'resource',
      test: (m) => {
        const actual = accessor(m);
        if (actual === undefined) {
          return { ok: false, reason: `${field} is unknown for this model` };
        }
        const ok = compare(actual, op, want);
        return {
          ok,
          reason: `${field}=${format(actual)} ${ok ? 'satisfies' : 'violates'} ${op}${format(want)}`,
        };
      },
    };
  }

  throw new RequirementSyntaxError(
    raw,
    'expected a capability name, `not_family_of:<ref>`, `provider:<name>`, ' +
      '`family!=<name>`, or `<field><op><number>` where field is one of ' +
      Object.keys(NUMERIC_FIELDS).join('/'),
  );
}

export function parseRequirements(list: readonly string[] | undefined): Requirement[] {
  return (list ?? []).map(parseRequirement);
}

/** The subset that `fallback:` is not permitted to relax. */
export function safetyOnly(requirements: readonly Requirement[]): Requirement[] {
  return requirements.filter((r) => r.kind === 'safety');
}

// ---------------------------------------------------------------------------

/**
 * Resolve the *excluded* target set. Accepts a literal model id, a single ref,
 * or a ref pointing at a list - the last case is what lets a cross-check guard
 * against every model a heterogeneous fan-out actually used, not just one.
 */
function resolveIndependenceTargets(
  refExpr: string,
  evalCtx: EvalContext,
  strict: boolean,
  familyResolver?: (modelId: string) => string | undefined,
): { ids: string[]; families: string[]; deferred?: boolean } {
  const expr = refExpr.trim();

  if (!isRef(expr)) {
    return normaliseTargets([expr], familyResolver);
  }

  try {
    const value = resolveRef(expr, evalCtx);
    if (value === undefined || value === null || value === '') {
      return { ids: [], families: [] };
    }
    if (Array.isArray(value)) return normaliseTargets(value.map((v) => String(v)), familyResolver);
    return normaliseTargets([String(value)], familyResolver);
  } catch (err) {
    if (strict) throw err;
    return { ids: [], families: [], deferred: true };
  }
}

function normaliseTargets(
  raw: readonly string[],
  familyResolver?: (modelId: string) => string | undefined,
): { ids: string[]; families: string[] } {
  const ids = raw.map((s) => s.trim()).filter((s) => s !== '');
  return { ids, families: ids.map((id) => familyResolver?.(id) ?? familyOf(id)) };
}

/**
 * Best-effort lineage inference, used ONLY when the id is not in the registry
 * (a literal target that was never bound, or a registry that has been edited
 * under a running workflow). The registry is always the authority.
 *
 *   anthropic/claude-sonnet-4-5  -> claude
 *   ollama/llama4-maverick       -> llama    (trailing version digits stripped)
 *   ollama/qwen3-235b            -> qwen
 *   openai/gpt-5-mini            -> gpt
 */
export function familyOf(modelId: string): string {
  const bare = modelId.includes('/') ? modelId.slice(modelId.indexOf('/') + 1) : modelId;
  const token = bare.split(/[-_.]/)[0] ?? bare;
  const stripped = token.replace(/\d+$/, '');
  const result = stripped.length > 0 ? stripped : token;
  return (result || bare).toLowerCase();
}

function parseQuantity(text: string): number {
  const t = text.trim().toLowerCase().replace(/_/g, '');
  const m = /^([0-9]*\.?[0-9]+)\s*([km])?$/.exec(t);
  if (!m) throw new RequirementSyntaxError(text, 'expected a number, optionally suffixed with k or m');
  const [, digits, suffix] = m as unknown as [string, string | undefined, string | undefined];
  const base = Number(digits);
  if (suffix === 'k') return base * 1_000;
  if (suffix === 'm') return base * 1_000_000;
  return base;
}

function compare(actual: number, op: string, want: number): boolean {
  switch (op) {
    case '<':
      return actual < want;
    case '<=':
      return actual <= want;
    case '>':
      return actual > want;
    case '>=':
      return actual >= want;
    case '==':
      return actual === want;
    case '!=':
      return actual !== want;
    default:
      return false;
  }
}

function format(n: number): string {
  if (n >= 1_000_000) return `${n / 1_000_000}m`;
  if (n >= 1_000) return `${n / 1_000}k`;
  return String(n);
}
