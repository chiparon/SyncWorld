import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatRunStatus } from '../../src/status/format.ts';
import type { AgentStatus, AgentStatusView, ResultStatus, RunStatus, TurnFacts } from '../../src/schema/types.ts';

function agent(patch: Partial<AgentStatusView> = {}): AgentStatusView {
  return {
    name: 'engineer-1', role: 'engineer', status: 'idle', branch: 'syncw/engineer-1',
    goal: 'Build the formatter.\nThen test it.', turns: 0, queued_messages: 0, ...patch,
  };
}

function run(agents: AgentStatusView[]): RunStatus {
  return { run_id: 'run-42', run_dir: 'E:\\Syncw\\runs\\run-42', agents };
}

function facts(patch: Partial<TurnFacts> = {}): TurnFacts {
  return {
    turn: 1, started_at: '2026-10-14T00:00:00Z', finished_at: '2026-10-14T00:00:45Z',
    duration_ms: 45_000, exit_code: 0, files_touched: [], timed_out: false, cancelled: false, ...patch,
  };
}

function result(status: ResultStatus, summary = 'First line.\r\nHidden summary line.'): AgentStatusView['last_turn'] {
  return {
    result: { status, summary, details: '', files_changed: [], open_questions: [] }, facts: facts(),
  };
}

test('header counts every status and columns preserve hiring order', () => {
  const states: AgentStatus[] = ['running', 'closed', 'queued', 'interrupted', 'idle', 'cancelled'];
  const agents = states.map((status, i) => agent({ name: `worker-${i}`, status, turns: i }));
  const text = formatRunStatus(run(agents));
  assert.ok(text.startsWith('Run: run-42\nDirectory: E:\\Syncw\\runs\\run-42\n'));
  assert.ok(text.includes('6 agents: 1 queued, 1 running, 1 idle, 1 cancelled, 1 interrupted, 1 closed'));
  const lines = text.split('\n');
  const heading = lines.find(line => line.startsWith('NAME'))!;
  const rows = lines.filter(line => line.startsWith('worker-'));
  assert.equal(rows.length, states.length);
  rows.forEach((row, i) => {
    assert.ok(row.startsWith(`worker-${i}`));
    assert.equal(row.indexOf('engineer'), heading.indexOf('ROLE'));
    assert.equal(row.indexOf(states[i]!), heading.indexOf('STATUS'));
    assert.equal(row.indexOf(String(i), heading.indexOf('TURNS')), heading.indexOf('TURNS'));
    assert.equal(row.indexOf('no result yet'), heading.indexOf('LAST RESULT'));
  });
  assert.equal(lines.filter(line => line === '  Goal: Build the formatter.').length, 6);
  assert.doesNotMatch(text, /Then test it|Running:|Queued messages:|\n$/);
});

for (const status of ['done', 'failed', 'blocked'] as const) {
  test(`shows a ${status} result and only its first summary line`, () => {
    const text = formatRunStatus(run([agent({ turns: 1, last_turn: result(status) })]));
    assert.ok(text.includes(`${status}: First line.`));
    assert.doesNotMatch(text, /Hidden summary line/);
  });
}

test('null results show errors and only the timeout and cancellation flags that are set', () => {
  for (const [timed_out, cancelled, expected] of [
    [false, false, 'no result'],
    [true, false, 'no result (timed out)'],
    [false, true, 'no result (cancelled)'],
    [true, true, 'no result (timed out, cancelled)'],
  ] as const) {
    const text = formatRunStatus(run([agent({
      last_turn: { result: null, facts: facts({ error: 'Engine crashed.\nStack trace.', timed_out, cancelled }) },
    })]));
    const row = text.split('\n').find(line => line.startsWith('engineer-1'))!;
    assert.ok(row.endsWith(`${expected}; error: Engine crashed.`));
    assert.doesNotMatch(text, /Stack trace|: no|: yes/);
  }
  const text = formatRunStatus(run([agent({ last_turn: { result: null, facts: facts() } })]));
  assert.match(text, /no result\n/);
  assert.doesNotMatch(text, /timed out|cancelled|error:/);
});

test('measured errors, timeouts and cancellations remain visible alongside valid results', () => {
  for (const status of ['done', 'failed', 'blocked'] as const) {
    for (const [patch, expected] of [
      [{ error: 'Auto-commit failed: hook rejected.\nHidden error.' }, `${status}: First line.; error: Auto-commit failed: hook rejected.`],
      [{ timed_out: true }, `${status} (timed out): First line.`],
      [{ cancelled: true }, `${status} (cancelled): First line.`],
      [{ timed_out: true, cancelled: true, error: 'Engine stopped.' }, `${status} (timed out, cancelled): First line.; error: Engine stopped.`],
    ] as const) {
      const last_turn = result(status)!;
      last_turn.facts = facts(patch);
      const text = formatRunStatus(run([agent({ last_turn })]));
      const row = text.split('\n').find(line => line.startsWith('engineer-1'))!;
      assert.ok(row.endsWith(expected));
      assert.doesNotMatch(text, /Hidden error|: no|: yes/);
    }
  }
});

test('summary, goal and error use their first non-blank line', () => {
  const last_turn = result('done', '\n \t\r\n\u001b[32m\u001b[0m\nSummary.\nHidden summary.')!;
  last_turn.facts.error = '\r\n\t \u2028Error.\nHidden error.';
  const text = formatRunStatus(run([agent({
    goal: '\n\t \u2029Goal.\nHidden goal.', last_turn,
  })]));
  assert.ok(text.includes('done: Summary.; error: Error.'));
  assert.ok(text.includes('  Goal: Goal.'));
  assert.doesNotMatch(text, /Hidden|\u001b/);
  last_turn.result = null;
  assert.ok(formatRunStatus(run([agent({ last_turn })])).includes('no result; error: Error.'));
});

test('blank summaries and errors do not produce empty labels', () => {
  const last_turn = result('done', '\n \t\n')!;
  last_turn.facts.error = '\r\n\t ';
  const text = formatRunStatus(run([agent({ last_turn })]));
  assert.match(text, /done\n/);
  assert.doesNotMatch(text, /done:|error:/);
});

test('elapsed time uses supplied seconds and queue counts appear only when nonzero', () => {
  for (const [seconds, expected] of [[0, '0s'], [45.9, '45s'], [60, '1m00s'], [192, '3m12s'], [3900, '1h05m']] as const) {
    const text = formatRunStatus(run([agent({ status: 'running', running_for_s: seconds, queued_messages: 2 })]));
    assert.ok(text.includes(`  Running: ${expected} | Queued messages: 2`));
  }
  const text = formatRunStatus(run([agent({ queued_messages: 1 })]));
  assert.ok(text.includes('  Queued messages: 1'));
  assert.doesNotMatch(text, /Running:/);
});

test('cuts all lines to terminal width, reserving a column for the ellipsis', () => {
  const status = run([agent({ last_turn: result('done', '完成测试并提交结果') })]);
  const full = formatRunStatus(status);
  const row = full.split('\n').find(line => line.startsWith('engineer-1'))!;
  const prefix = row.slice(0, row.indexOf('完成'));
  const width = prefix.length + 5;
  const cut = formatRunStatus(status, { width });
  assert.ok(cut.includes(`${prefix}完成…`));
  for (const line of cut.split('\n')) {
    const cells = Array.from(line).reduce((sum, char) => sum + (/\p{Script=Han}/u.test(char) ? 2 : 1), 0);
    assert.ok(cells <= width);
  }
  for (const width of [1, 2, 8, 20]) {
    const text = formatRunStatus(status, { width });
    assert.ok(text.split('\n').every(line => line.length <= width));
    assert.ok(text.includes('…'));
    assert.ok(!text.endsWith('\n'));
  }
  assert.equal(formatRunStatus(status, { width: 1000 }), full);
});

test('wide names align and combining characters stay intact at the cut', () => {
  const text = formatRunStatus(run([agent({ name: '工程师一号' }), agent({ name: 'worker-2' })]));
  assert.ok(text.includes('工程师一号  engineer'));
  assert.ok(text.includes('worker-2    engineer'));
  const status = run([agent({ goal: 'e\u0301中文👩‍💻abcdef' })]);
  assert.ok(formatRunStatus(status, { width: 10 }).includes('  Goal: e\u0301…'));
  assert.ok(formatRunStatus(status, { width: 16 }).includes('  Goal: e\u0301中文👩‍💻…'));
});

test('no width means no cutting, and output is deterministic without mutating the input', () => {
  const summary = '完成' + 'very long summary '.repeat(100);
  const goal = 'very long goal '.repeat(100);
  const status = run([agent({ goal, last_turn: result('done', summary) })]);
  const before = structuredClone(status);
  const text = formatRunStatus(status);
  assert.ok(text.includes(summary));
  assert.ok(text.includes(goal));
  assert.equal(formatRunStatus(status, {}), text);
  assert.equal(formatRunStatus(status), text);
  assert.deepEqual(status, before);
});

test('removes terminal escape codes and normalizes tabs in text fields', () => {
  const status = run([agent({
    name: '\u001b[31mengineer-1\u001b[0m', goal: 'Build\tthis.\rHidden goal.',
    last_turn: result('done', '\u001b[32mReady\u001b[0m'),
  })]);
  const text = formatRunStatus(status);
  assert.doesNotMatch(text, /\u001b|\t|Hidden goal/);
  assert.ok(text.includes('done: Ready'));
  assert.ok(text.includes('Goal: Build this.'));
});

test('empty run prints the header and explains there are no agents yet', () => {
  assert.equal(formatRunStatus(run([])), [
    'Run: run-42', 'Directory: E:\\Syncw\\runs\\run-42', '0 agents', 'This run has no agents yet.',
  ].join('\n'));
});

test('unusable widths leave output uncut', () => {
  const status = run([agent({ last_turn: result('done', '完成测试'.repeat(30)) })]);
  const full = formatRunStatus(status);
  for (const width of [0, -1, 0.5, NaN, Infinity, -Infinity]) {
    assert.equal(formatRunStatus(status, { width }), full);
  }
});

test('usable fractional widths are floored before cutting', () => {
  const status = run([agent({ last_turn: result('done', '完成测试'.repeat(30)) })]);
  for (const width of [1.5, 20.9, 60.5]) {
    const text = formatRunStatus(status, { width });
    assert.equal(text, formatRunStatus(status, { width: Math.floor(width) }));
    assert.ok(text.includes('…'));
  }
});
