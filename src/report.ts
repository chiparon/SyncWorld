/**
 * Terminal reporting: binding plans, run summaries, and the replay diff.
 *
 * Presentation only - nothing here influences execution.
 */

import type { BindingDecision, NodeRunRecord, RunMeta, WorkflowSpec } from './schema/types.ts';

const useColor = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;

const c = {
  dim: (s: string) => wrap(s, '2'),
  bold: (s: string) => wrap(s, '1'),
  red: (s: string) => wrap(s, '31'),
  green: (s: string) => wrap(s, '32'),
  yellow: (s: string) => wrap(s, '33'),
  blue: (s: string) => wrap(s, '36'),
  magenta: (s: string) => wrap(s, '35'),
};

function wrap(s: string, code: string): string {
  return useColor ? `\u001b[${code}m${s}\u001b[0m` : s;
}

export function rule(width = 78): string {
  return c.dim('─'.repeat(width));
}

export function table(headers: string[], rows: string[][], indent = '  '): string {
  const widths = headers.map((h, i) =>
    Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ''))),
  );
  const line = (cells: string[]): string =>
    indent +
    cells
      .map((cell, i) => padTo(cell, widths[i]!))
      .join('  ')
      .trimEnd();
  return [line(headers.map((h) => c.bold(h))), ...rows.map(line)].join('\n');
}

// ---------------------------------------------------------------------------
// Binding plan (syncw bind)
// ---------------------------------------------------------------------------

export interface PlanRow {
  node: string;
  decision: BindingDecision;
  fanOut: boolean;
}

export function renderBindingPlan(
  workflow: WorkflowSpec,
  rows: PlanRow[],
  opts: { explain?: boolean } = {},
): string {
  const out: string[] = [];
  out.push(c.bold(`binding plan  ${workflow.name}`));
  out.push('');

  const tableRows: string[][] = [];
  for (const row of rows) {
    const d = row.decision;
    const model = d.model;
    tableRows.push([
      row.node + (row.fanOut ? c.dim(' ×n') : ''),
      model ? colorModel(model.id, model.family) : c.red('UNBOUND'),
      d.source,
      model ? `${model.cost.in}/${model.cost.out}` : '-',
      model ? `${fmtCtx(model.ctx)}` : '-',
      model ? String(model.quality ?? '-') : '-',
      firstReason(d),
    ]);
  }
  out.push(table(tableRows.length ? ['node', 'model', 'source', '$/Mtok in/out', 'ctx', 'q', 'why'] : [], tableRows));

  if (opts.explain) {
    for (const row of rows) {
      out.push('');
      out.push(c.bold(`  ${row.node}`));
      for (const reason of row.decision.reasons) out.push(`    ${c.blue('·')} ${reason}`);
      out.push(`    ${c.dim('candidates:')}`);
      const cands = [...row.decision.candidates].sort((a, b) => Number(b.ok) - Number(a.ok));
      for (const cand of cands.slice(0, 12)) {
        const mark = cand.ok ? c.green('✓') : c.dim('✗');
        const score = cand.score !== undefined ? c.dim(` [${cand.score.toFixed(3)}]`) : '';
        out.push(`      ${mark} ${cand.id}${score} ${c.dim(cand.reasons.join('; '))}`);
      }
      if (cands.length > 12) out.push(c.dim(`      … ${cands.length - 12} more`));
    }
  }

  out.push('');
  const unbound = rows.filter((r) => !r.decision.model);
  if (unbound.length > 0) {
    out.push(c.red(`  ${unbound.length} node(s) could not be bound:`));
    for (const row of unbound) {
      out.push(c.red(`    ${row.node}: ${row.decision.reasons.join(' ')}`));
    }
  } else {
    out.push(c.green('  all nodes bound.'));
  }
  return out.join('\n');
}

function firstReason(d: BindingDecision): string {
  const r = d.reasons[0] ?? '';
  return r.length > 46 ? `${r.slice(0, 45)}…` : r;
}

// ---------------------------------------------------------------------------
// Run summary
// ---------------------------------------------------------------------------

export function renderRunSummary(meta: RunMeta, verbose = false): string {
  const out: string[] = [];
  const badge =
    meta.status === 'ok'
      ? c.green('ok')
      : meta.status === 'budget_exceeded'
        ? c.yellow('budget exceeded')
        : c.red('failed');

  out.push('');
  out.push(
    `${c.bold(meta.runId)}  ${badge}  ` +
      `${c.dim('workflow')} ${meta.workflow}  ` +
      `${c.dim('cost')} ${c.bold(`$${meta.totalCostUsd.toFixed(4)}`)}  ` +
      `${c.dim('tokens')} ${meta.totalTokens.in}↓ ${meta.totalTokens.out}↑` +
      (meta.replayOf ? `  ${c.magenta(`replay of ${meta.replayOf}`)}` : ''),
  );
  if (meta.error) out.push(`  ${c.red(meta.error)}`);
  out.push('');

  const rows = meta.nodes.map((n) => [
    n.node,
    n.status === 'ok' ? c.green('ok') : n.status === 'skipped' ? c.dim('skip') : c.red('fail'),
    n.model ?? n.bindingSource ?? '-',
    `$${n.costUsd.toFixed(4)}`,
    `${n.tokens.in}↓ ${n.tokens.out}↑`,
    `${n.latencyMs}ms`,
    n.items && n.items > 1 ? `${n.items}×` : '',
    n.attempts > (n.items ?? 1) ? c.yellow(`${n.attempts} attempts`) : '',
    n.cacheHits ? c.dim(`${n.cacheHits} cached`) : '',
  ]);
  out.push(table(['node', 'status', 'model', 'cost', 'tokens', 'latency', 'fan', '', ''], rows));

  if (verbose) {
    out.push('');
    for (const n of meta.nodes) {
      if (!n.bindingReasons?.length) continue;
      out.push(c.dim(`  ${n.node} bound to ${n.model}:`));
      for (const r of n.bindingReasons) out.push(c.dim(`    · ${r}`));
    }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Replay diff
// ---------------------------------------------------------------------------

export interface NodeDiff {
  node: string;
  kind: 'same' | 'changed' | 'only-a' | 'only-b';
  modelA?: string;
  modelB?: string;
  costA: number;
  costB: number;
  cached: boolean;
  outputChanges: Array<{ path: string; before: string; after: string }>;
}

export function diffRuns(a: RunMeta, b: RunMeta): NodeDiff[] {
  const byNodeA = new Map(a.nodes.map((n) => [n.node, n]));
  const byNodeB = new Map(b.nodes.map((n) => [n.node, n]));
  const names = [...new Set([...byNodeA.keys(), ...byNodeB.keys()])];

  return names.map((node) => {
    const na = byNodeA.get(node);
    const nb = byNodeB.get(node);

    if (!na) {
      return {
        node,
        kind: 'only-b' as const,
        ...(nb?.model ? { modelB: nb.model } : {}),
        costA: 0,
        costB: nb?.costUsd ?? 0,
        cached: false,
        outputChanges: [],
      };
    }
    if (!nb) {
      return {
        node,
        kind: 'only-a' as const,
        ...(na.model ? { modelA: na.model } : {}),
        costA: na.costUsd,
        costB: 0,
        cached: false,
        outputChanges: [],
      };
    }

    const changes: Array<{ path: string; before: string; after: string }> = [];
    structuralDiff(na.output, nb.output, '', changes, 0);

    const modelChanged = (na.model ?? '') !== (nb.model ?? '');
    return {
      node,
      kind: modelChanged || changes.length > 0 ? ('changed' as const) : ('same' as const),
      ...(na.model ? { modelA: na.model } : {}),
      ...(nb.model ? { modelB: nb.model } : {}),
      costA: na.costUsd,
      costB: nb.costUsd,
      cached: nb.cacheHits > 0,
      outputChanges: changes,
    };
  });
}

/**
 * Field-level diff of node outputs. Structural rather than textual: a JSON line
 * diff of two model responses is unreadable, whereas
 * `verdict.confidence 0.61 -> 0.88` is the whole story.
 */
function structuralDiff(
  a: unknown,
  b: unknown,
  path: string,
  out: Array<{ path: string; before: string; after: string }>,
  depth: number,
): void {
  if (out.length >= 24 || depth > 6) return;

  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      out.push({ path: path === '' ? '(root)' : path, before: short(a), after: short(b) });
    }
    return;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    const la = Array.isArray(a) ? a : [];
    const lb = Array.isArray(b) ? b : [];
    if (la.length !== lb.length) {
      out.push({ path: `${path}.length`, before: String(la.length), after: String(lb.length) });
    }
    const n = Math.min(la.length, lb.length);
    for (let i = 0; i < n && out.length < 24; i++) {
      structuralDiff(la[i], lb[i], `${path}[${i}]`, out, depth + 1);
    }
    return;
  }

  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const key of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
    if (out.length >= 24) break;
    structuralDiff(ra[key], rb[key], joinPath(path, key), out, depth + 1);
  }
}

function joinPath(base: string, key: string): string {
  if (base === '') return key;
  if (base.endsWith(']')) return `${base}.${key}`;
  return `${base}.${key}`;
}

function short(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  const flat = (s ?? 'undefined').replace(/\s+/g, ' ');
  return flat.length > 84 ? `${flat.slice(0, 83)}…` : flat;
}

export function renderDiff(
  a: RunMeta,
  worldA: Record<string, unknown>,
  b: RunMeta,
  worldB: Record<string, unknown>,
  opts: { full?: boolean } = {},
): string {
  const out: string[] = [];
  const diffs = diffRuns(a, b);

  out.push('');
  out.push(`${c.bold('replay diff')}  ${c.dim(a.runId)} ${c.dim('→')} ${c.blue(b.runId)}`);
  if (b.replayOf) out.push(c.dim(`  replayOf=${b.replayOf}`));
  if (b.swaps && Object.keys(b.swaps).length) {
    for (const [node, model] of Object.entries(b.swaps)) {
      out.push(`  ${c.magenta('swap')} ${node} ${c.dim('→')} ${model}`);
    }
  }
  out.push('');

  const rows = diffs.map((d) => {
    const modelCell =
      d.kind === 'only-a' || d.kind === 'only-b'
        ? c.dim('(absent)')
        : d.modelA === d.modelB
          ? c.dim(d.modelA ?? '-')
          : `${c.dim(d.modelA ?? '-')} ${c.dim('→')} ${c.blue(d.modelB ?? '-')}`;
    const delta = d.costB - d.costA;
    const deltaCell =
      Math.abs(delta) < 1e-9
        ? c.dim('=')
        : delta > 0
          ? c.red(`+$${delta.toFixed(4)}`)
          : c.green(`-$${Math.abs(delta).toFixed(4)}`);
    const mark = d.kind === 'changed' ? c.yellow('~') : d.kind === 'same' ? c.dim('=') : c.magenta('+');
    return [
      `${mark} ${d.node}`,
      modelCell,
      d.cached ? c.dim('cached') : 'live',
      `$${d.costA.toFixed(4)}`,
      `$${d.costB.toFixed(4)}`,
      deltaCell,
      d.outputChanges.length ? String(d.outputChanges.length) : c.dim('-'),
    ];
  });
  out.push(table(['node', 'model', 'B source', 'cost A', 'cost B', 'Δcost', 'Δfields'], rows));

  const totalDelta = b.totalCostUsd - a.totalCostUsd;
  out.push('');
  out.push(
    `  ${c.dim('total')} $${a.totalCostUsd.toFixed(4)} ${c.dim('→')} $${b.totalCostUsd.toFixed(4)}  ` +
      (Math.abs(totalDelta) < 1e-9
        ? c.dim('(no change)')
        : totalDelta > 0
          ? c.red(`+$${totalDelta.toFixed(4)}`)
          : c.green(`-$${Math.abs(totalDelta).toFixed(4)}`)),
  );

  // Cached nodes contribute $0 to run B's total, so the two totals are not
  // like-for-like. Comparing them directly would let a swap look like a saving
  // while a node you never touched got 50x more expensive - so report the
  // comparison over the nodes that actually spent money in run B.
  const live = diffs.filter((d) => !d.cached && d.kind === 'changed');
  if (live.length > 0 && live.length < diffs.length) {
    const liveA = live.reduce((s, d) => s + d.costA, 0);
    const liveB = live.reduce((s, d) => s + d.costB, 0);
    const liveDelta = liveB - liveA;
    out.push(
      c.dim(`  like-for-like, over the ${live.length} node(s) that made a live call in B: `) +
        `$${liveA.toFixed(4)} ${c.dim('→')} $${liveB.toFixed(4)}  ` +
        (Math.abs(liveDelta) < 1e-9
          ? c.dim('(no change)')
          : liveDelta > 0
            ? c.red(`+$${liveDelta.toFixed(4)}`)
            : c.green(`-$${Math.abs(liveDelta).toFixed(4)}`)),
    );
    out.push(
      c.dim(
        `  (the ${diffs.length - live.length} cached/unchanged node(s) cost nothing in B, ` +
          `which is why the totals above are not directly comparable)`,
      ),
    );
  }

  const interesting = diffs.filter((d) => d.outputChanges.length > 0);
  if (interesting.length > 0) {
    out.push('');
    out.push(c.bold('  what actually changed'));
    for (const d of interesting) {
      out.push('');
      out.push(`  ${c.bold(d.node)}  ${c.dim(`${d.outputChanges.length} field(s)`)}`);
      const shown = opts.full ? d.outputChanges : d.outputChanges.slice(0, 6);
      for (const ch of shown) {
        out.push(`    ${c.yellow(ch.path)}`);
        out.push(`      ${c.red(`- ${ch.before}`)}`);
        out.push(`      ${c.green(`+ ${ch.after}`)}`);
      }
      if (!opts.full && d.outputChanges.length > shown.length) {
        out.push(c.dim(`    … ${d.outputChanges.length - shown.length} more (use --full)`));
      }
    }
  }

  const worldChanged = [...new Set([...Object.keys(worldA), ...Object.keys(worldB)])].filter(
    (f) => JSON.stringify(worldA[f]) !== JSON.stringify(worldB[f]),
  );
  out.push('');
  out.push(
    worldChanged.length
      ? `  ${c.dim('world fields that differ:')} ${worldChanged.join(', ')}`
      : c.dim('  world state is identical between the two runs.'),
  );

  const unchanged = diffs.filter((d) => d.kind === 'same').length;
  if (unchanged > 0) {
    out.push(
      c.dim(
        `  ${unchanged} node(s) byte-identical - the content-addressed cache served them, ` +
          `so the diff above isolates exactly your change.`,
      ),
    );
  }

  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Misc renderers
// ---------------------------------------------------------------------------

export function renderModels(
  models: Array<{
    id: string;
    label?: string;
    family: string;
    ctx: number;
    cost: { in: number; out: number };
    caps: string[];
    quality?: number;
    latencyP50Ms?: number;
  }>,
): string {
  const rows = models.map((m) => [
    colorModel(m.id, m.family),
    m.family,
    fmtCtx(m.ctx),
    `${m.cost.in}/${m.cost.out}`,
    m.quality !== undefined ? String(m.quality) : '-',
    m.latencyP50Ms !== undefined ? `${m.latencyP50Ms}ms` : '-',
    m.caps.join(','),
  ]);
  return table(['model', 'family', 'ctx', '$/Mtok in/out', 'quality', 'p50', 'capabilities'], rows);
}

export function renderProviders(
  list: Array<{ name: string; kind: string; ready: boolean; detail: string }>,
): string {
  const rows = list.map((p) => [
    p.name,
    p.kind,
    p.ready ? c.green('ready') : c.yellow('not configured'),
    c.dim(p.detail),
  ]);
  return table(['provider', 'kind', 'status', 'detail'], rows);
}

function colorModel(id: string, family?: string): string {
  const palette: Record<string, (s: string) => string> = {
    claude: c.magenta,
    gpt: c.green,
    gemini: c.blue,
    deepseek: c.yellow,
  };
  const fn = family ? palette[family] : undefined;
  return fn ? fn(id) : id;
}

function fmtCtx(n: number): string {
  if (n >= 1_000_000) return `${n / 1_000_000}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function displayWidth(s: string): number {
  const stripped = s.replace(/\u001b\[[0-9;]*m/g, '');
  let width = 0;
  for (const ch of stripped) {
    width += ch.charCodeAt(0) > 0x1100 ? 2 : 1;
  }
  return width;
}

function padTo(s: string, width: number): string {
  const pad = width - displayWidth(s);
  return pad > 0 ? s + ' '.repeat(pad) : s;
}

export function statusGlyph(status: NodeRunRecord['status']): string {
  if (status === 'ok') return c.green('✔');
  if (status === 'skipped') return c.dim('⤵');
  return c.red('✘');
}

export { c as colors };