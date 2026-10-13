import { stripVTControlCharacters } from 'node:util';
import type { AgentStatus, AgentStatusView, RunStatus, StatusFormatOptions } from '../schema/types.ts';

const statuses: AgentStatus[] = ['queued', 'running', 'idle', 'cancelled', 'interrupted', 'closed'];
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

function firstLine(text: string): string {
  return (stripVTControlCharacters(text).split(/[\r\n\u2028\u2029]/, 1)[0] ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

function firstNonBlankLine(text: string): string {
  return stripVTControlCharacters(text).split(/[\r\n\u2028\u2029]/)
    .map(firstLine).find(line => line.trim().length > 0) ?? '';
}

/** Count display cells, keeping combining sequences and emoji together when cutting. */
function cellWidth(grapheme: string): number {
  const visible = grapheme.replace(/[\p{Mark}\p{Cf}]/gu, '');
  if (!visible) return 0;
  if (/\p{Emoji_Presentation}/u.test(grapheme) || /\uFE0F|\u20E3/u.test(grapheme)) return 2;
  const code = visible.codePointAt(0)!;
  return code >= 0x1100 && (
    code <= 0x115f || code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x16fe0 && code <= 0x18dff) ||
    (code >= 0x1aff0 && code <= 0x1b2ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) ? 2 : 1;
}

function textWidth(text: string): number {
  let width = 0;
  for (const { segment } of segmenter.segment(text)) width += cellWidth(segment);
  return width;
}

function cut(text: string, width: number): string {
  if (textWidth(text) <= width) return text;
  let prefix = '';
  let used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const cells = cellWidth(segment);
    if (used + cells > width - 1) break;
    prefix += segment;
    used += cells;
  }
  return `${prefix}…`;
}

function duration(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  if (whole < 60) return `${whole}s`;
  if (whole < 3600) return `${Math.floor(whole / 60)}m${String(whole % 60).padStart(2, '0')}s`;
  return `${Math.floor(whole / 3600)}h${String(Math.floor(whole / 60) % 60).padStart(2, '0')}m`;
}

function lastResult(agent: AgentStatusView): string {
  if (!agent.last_turn) return 'no result yet';
  const { result, facts } = agent.last_turn;
  const flags = [];
  if (facts.timed_out) flags.push('timed out');
  if (facts.cancelled) flags.push('cancelled');
  const outcome = `${result?.status ?? 'no result'}${flags.length ? ` (${flags.join(', ')})` : ''}`;
  const summary = result ? firstNonBlankLine(result.summary) : '';
  const error = firstNonBlankLine(facts.error ?? '');
  return `${outcome}${summary ? `: ${summary}` : ''}${error ? `; error: ${error}` : ''}`;
}

/**
 * Renders a run's status as plain text for a terminal, without a trailing
 * newline. `syncw status` prints it.
 */
export function formatRunStatus(status: RunStatus, opts?: StatusFormatOptions): string {
  const requestedWidth = opts?.width;
  const width = typeof requestedWidth === 'number' && Number.isFinite(requestedWidth) && requestedWidth >= 1
    ? Math.floor(requestedWidth) : undefined;
  const counts = statuses.map(state => {
    const count = status.agents.filter(agent => agent.status === state).length;
    return count ? `${count} ${state}` : '';
  }).filter(Boolean);
  const count = status.agents.length;
  const lines = [
    `Run: ${firstLine(status.run_id)}`,
    `Directory: ${firstLine(status.run_dir)}`,
    `${count} agent${count === 1 ? '' : 's'}${counts.length ? `: ${counts.join(', ')}` : ''}`,
  ];
  if (count === 0) {
    lines.push('This run has no agents yet.');
  } else {
    const headings = ['NAME', 'ROLE', 'STATUS', 'TURNS', 'LAST RESULT'];
    const rows = status.agents.map(agent => [
      firstLine(agent.name), firstLine(agent.role), agent.status, String(agent.turns), lastResult(agent),
    ]);
    const widths = headings.map((heading, i) => Math.max(textWidth(heading), ...rows.map(row => textWidth(row[i]!))));
    const rowText = (row: string[]) => row.map((cell, i) =>
      i === row.length - 1 ? cell : cell + ' '.repeat(widths[i]! - textWidth(cell)),
    ).join('  ');
    lines.push('', rowText(headings));
    status.agents.forEach((agent, i) => {
      lines.push(rowText(rows[i]!), `  Goal: ${firstNonBlankLine(agent.goal)}`);
      const extra: string[] = [];
      if (agent.running_for_s !== undefined) extra.push(`Running: ${duration(agent.running_for_s)}`);
      if (agent.queued_messages > 0) extra.push(`Queued messages: ${agent.queued_messages}`);
      if (extra.length) lines.push(`  ${extra.join(' | ')}`);
    });
  }
  return lines.map(line => width === undefined ? line : cut(line, width)).join('\n');
}
