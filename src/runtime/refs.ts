/**
 * Reference expressions and micro-guards.
 *
 *   $.input.goal                     run input
 *   $.world.plan                     a world field
 *   $.world.plan.questions           nested inside a world field
 *   $.nodes.implement.actual_model   what a *previous node actually ran on*
 *   $                                the current fan-out item
 *   $.item.confidence                same, addressed explicitly
 *   anything else                    a literal
 *
 * `$.nodes.<id>.actual_model` is what makes cross-model constraints writable
 * declaratively: "the verifier must not share a family with whatever the
 * implementer actually ran on" is a one-liner, and it stays correct even when
 * the implementer's model was chosen at runtime by policy.
 */

import type { World } from './world.ts';

export interface NodeView {
  actual_model?: string;
  actual_family?: string;
  /**
   * Every distinct model / lineage this node actually ran on. Always present
   * after the node completes - a fan-out that collapsed onto one model is still
   * a fan-out, and `not_family_of: $.nodes.x.actual_families` must keep working.
   */
  actual_models?: string[];
  actual_families?: string[];
  provider?: string;
  status?: string;
  cost_usd?: number;
  output?: unknown;
}

export interface EvalContext {
  input: Record<string, unknown>;
  world: World;
  nodes: Map<string, NodeView>;
  item?: unknown;
  itemIndex?: number;
}

export class RefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefError';
  }
}

export function isRef(expr: string): boolean {
  return expr.trim().startsWith('$');
}

export function resolveRef(expr: string, ctx: EvalContext): unknown {
  const trimmed = expr.trim();
  if (!trimmed.startsWith('$')) return expr;

  if (trimmed === '$' || trimmed === '$.item') return ctx.item;

  const rest = trimmed.slice(1).replace(/^\./, '');
  if (rest === '') return ctx.item;

  const segments = rest.split('.');
  const head = segments[0]!;
  const tail = segments.slice(1);

  if (head === 'item') {
    return descend(ctx.item, tail, `$.${segments.join('.')}`);
  }

  if (head === 'input') {
    return descend(ctx.input, tail, `$.${segments.join('.')}`);
  }

  if (head === 'world') {
    const field = tail[0];
    if (field === undefined) {
      throw new RefError('`$.world` needs a field name, e.g. `$.world.plan`');
    }
    const value = ctx.world.get(field);
    return descend(value, tail.slice(1), `$.world.${tail.join('.')}`);
  }

  if (head === 'nodes') {
    const nodeId = tail[0];
    if (nodeId === undefined) {
      throw new RefError('`$.nodes` needs a node id, e.g. `$.nodes.implement.actual_model`');
    }
    const view = ctx.nodes.get(nodeId);
    if (!view) {
      throw new RefError(
        `$.nodes.${nodeId} is not available yet. A node may only reference nodes ` +
          `listed in its \`needs:\`.`,
      );
    }
    const key = tail[1];
    if (key === undefined) return view;
    const value = (view as Record<string, unknown>)[key];
    if (value === undefined && !(key in view)) {
      const known = Object.keys(view).join(', ');
      throw new RefError(`$.nodes.${nodeId}.${key} does not exist. Available: ${known}`);
    }
    return descend(value, tail.slice(2), `$.nodes.${nodeId}.${key}`);
  }

  throw new RefError(
    `unsupported reference "${trimmed}". Roots are: $.input, $.world, $.nodes, $ (item)`,
  );
}

function descend(value: unknown, path: string[], label: string): unknown {
  let cur = value;
  for (const seg of path) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx)) {
        throw new RefError(`${label}: "${seg}" is not a numeric index`);
      }
      cur = cur[idx];
      continue;
    }
    if (typeof cur !== 'object') {
      throw new RefError(`${label}: cannot read "${seg}" from a ${typeof cur}`);
    }
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Resolve an input wiring map into a concrete object. */
export function resolveInputs(
  wiring: Record<string, string> | undefined,
  ctx: EvalContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, expr] of Object.entries(wiring ?? {})) {
    out[key] = resolveRef(expr, ctx);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Guards: a deliberately tiny, eval-free expression language
// ---------------------------------------------------------------------------

const GUARD_RE = /^\s*(.+?)\s*(==|!=|<=|>=|<|>)\s*(.+?)\s*$/;

/**
 * Evaluate a guard such as `$.world.verdict.confidence < 0.7`.
 * Supports a single comparison, or a bare reference (truthiness).
 * No `eval`, no arbitrary code - a workflow file is data, never code.
 */
export function evalGuard(expr: string, ctx: EvalContext): boolean {
  const m = GUARD_RE.exec(expr);
  if (!m) {
    return truthy(resolveRef(expr, ctx));
  }
  const [, lhsExpr, op, rhsExpr] = m as unknown as [string, string, string, string];
  const lhs = isRef(lhsExpr) ? resolveRef(lhsExpr, ctx) : coerceLiteral(lhsExpr);
  const rhs = isRef(rhsExpr) ? resolveRef(rhsExpr, ctx) : coerceLiteral(rhsExpr);

  switch (op) {
    case '==':
      return looseEq(lhs, rhs);
    case '!=':
      return !looseEq(lhs, rhs);
    case '<':
      return cmp(lhs, rhs) < 0;
    case '<=':
      return cmp(lhs, rhs) <= 0;
    case '>':
      return cmp(lhs, rhs) > 0;
    case '>=':
      return cmp(lhs, rhs) >= 0;
    default:
      return false;
  }
}

function cmp(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

function looseEq(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' || typeof b === 'number') {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  }
  return String(a) === String(b);
}

function coerceLiteral(text: string): unknown {
  const t = text.trim().replace(/^['"]|['"]$/g, '');
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  const n = Number(t);
  return Number.isFinite(n) && t !== '' ? n : t;
}

function truthy(v: unknown): boolean {
  if (v === undefined || v === null || v === false) return false;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}
