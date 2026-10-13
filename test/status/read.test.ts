import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { AgentRecord, TurnRecord } from '../../src/schema/types.ts';
import { findLatestRun, readRunStatus } from '../../src/status/read.ts';

function fixture(t: TestContext) {
  const runsDir = mkdtempSync(join(tmpdir(), 'syncw-status-'));
  t.after(() => {
    assert.equal(dirname(resolve(runsDir)), resolve(tmpdir()));
    rmSync(runsDir, { recursive: true, force: true });
  });
  function run(id: string, agents?: AgentRecord[]) {
    const directory = join(runsDir, id);
    mkdirSync(directory);
    if (agents !== undefined) writeFileSync(join(directory, 'agents.json'), JSON.stringify(agents));
    return directory;
  }
  return { runsDir, run };
}

function agent(patch: Partial<AgentRecord> = {}): AgentRecord {
  return {
    name: 'engineer-1', role: 'engineer', brief: 'Implement the task.',
    task: { goal: 'Keep the goal\nverbatim.' }, engine: 'codex', hired_by: 'scheduler',
    repo: '/repo', base: 'abc', branch: 'syncw/engineer-1', worktree: '/worktree',
    status: 'idle', turns: [], queued_messages: [], created_at: '2026-10-14T00:00:00Z',
    ...patch,
  };
}

const turn: TurnRecord = {
  input: 'Do the work.', reported: true,
  result: { status: 'done', summary: 'Finished.', details: '', files_changed: [], open_questions: [] },
  facts: {
    turn: 1, started_at: '2026-10-14T00:00:00Z', finished_at: '2026-10-14T00:00:01Z',
    duration_ms: 1000, exit_code: 0, files_touched: [], timed_out: false, cancelled: false,
  },
};

test('newest non-empty run wins by name, skipping empty runs and old directories', (t) => {
  const { runsDir, run } = fixture(t);
  const selected = run('20261014-020000-aaaa', [agent()]);
  run('20261014-010000-aaaa', [agent({ name: 'older-1' })]);
  run('20261014-030000-aaaa', []);
  run('20261014-040000-aaaa');
  writeFileSync(join(runsDir, '20261014-050000-aaaa'), 'not a directory');
  assert.equal(findLatestRun(runsDir), '20261014-020000-aaaa');
  const before = readFileSync(join(selected, 'agents.json'), 'utf8');
  const result = readRunStatus({ runsDir });
  assert.equal(result.run_id, '20261014-020000-aaaa');
  assert.equal(result.run_dir, selected);
  assert.equal(result.agents[0]?.name, 'engineer-1');
  assert.equal(readFileSync(join(selected, 'agents.json'), 'utf8'), before);
});

test('explicit run selects an older run or an empty run and preserves agent order and last turn', (t) => {
  const { runsDir, run } = fixture(t);
  const directory = run('older', [agent({ turns: [turn], queued_messages: ['next'] }), agent({ name: 'reviewer-1' })]);
  run('newer', []);
  assert.deepEqual(readRunStatus({ runsDir, runId: 'older' }), {
    run_id: 'older', run_dir: directory,
    agents: [
      { name: 'engineer-1', role: 'engineer', status: 'idle', branch: 'syncw/engineer-1',
        goal: 'Keep the goal\nverbatim.', turns: 1, queued_messages: 1, last_turn: { result: turn.result, facts: turn.facts } },
      { name: 'reviewer-1', role: 'engineer', status: 'idle', branch: 'syncw/engineer-1',
        goal: 'Keep the goal\nverbatim.', turns: 0, queued_messages: 0 },
    ],
  });
  assert.deepEqual(readRunStatus({ runsDir, runId: 'newer' }).agents, []);
});

test('running time uses the next prompt mtime and an injected clock, only while running', (t) => {
  const { runsDir, run } = fixture(t);
  const directory = run('run', [
    agent({ status: 'running', turns: [turn] }),
    agent({ name: 'missing-1', status: 'running' }),
    agent({ name: 'idle-1' }),
  ]);
  const started = new Date('2026-10-14T00:00:00Z');
  for (const [name, number] of [['engineer-1', 2], ['idle-1', 1]] as const) {
    mkdirSync(join(directory, name));
    const prompt = join(directory, name, `turn-${number}.prompt.md`);
    writeFileSync(prompt, 'prompt');
    utimesSync(prompt, started, started);
  }
  const status = readRunStatus({ runsDir, now: () => started.getTime() + 12_999 });
  assert.equal(status.agents[0]?.running_for_s, 12);
  assert.equal('running_for_s' in status.agents[1]!, false);
  assert.equal('running_for_s' in status.agents[2]!, false);
  assert.equal(existsSync(join(directory, 'missing-1')), false);
  assert.equal(readRunStatus({ runsDir, now: () => started.getTime() - 1000 }).agents[0]?.running_for_s, 0);
});

test('no eligible run names the directory, including a missing directory, without creating it', (t) => {
  const { runsDir, run } = fixture(t);
  run('empty', []);
  run('old');
  for (const directory of [runsDir, join(runsDir, 'missing')]) {
    assert.throws(() => readRunStatus({ runsDir: directory }), (error: Error) => {
      assert.ok(error.message.includes(directory));
      assert.match(error.message, /No run with agents.*Start a Syncw run/);
      return true;
    });
  }
  assert.equal(existsSync(join(runsDir, 'missing')), false);
});

test('unknown explicit runs are rejected; a selected legacy run reports its missing agents file', (t) => {
  const { runsDir, run } = fixture(t);
  for (const runId of ['unknown', '', '..', '../outside']) {
    assert.throws(() => readRunStatus({ runsDir, runId }), /Unknown run.*Choose an existing run id/);
  }
  const directory = run('legacy');
  assert.throws(() => readRunStatus({ runsDir, runId: 'legacy' }), (error: Error) => {
    assert.ok(error.message.includes(join(directory, 'agents.json')));
    assert.match(error.message, /Cannot read.*Check/);
    return true;
  });
});

for (const problem of ['unreadable', 'invalid JSON', 'not an array'] as const) {
  test(`${problem} names the file and does not silently fall back to an older run`, (t) => {
    const { runsDir, run } = fixture(t);
    run('a-older', [agent()]);
    const directory = run('z-broken');
    const file = join(directory, 'agents.json');
    // A directory at the file path is unreadable as a file on every supported platform.
    if (problem === 'unreadable') mkdirSync(file);
    else writeFileSync(file, problem === 'invalid JSON' ? '{' : '{}');
    for (const runId of [undefined, 'z-broken']) {
      assert.throws(() => readRunStatus({ runsDir, runId }), (error: Error) => {
        assert.ok(error.message.includes(file));
        assert.match(error.message, problem === 'unreadable' ? /Cannot read.*Check/ : /Repair or restore/);
        return true;
      });
    }
  });
}
