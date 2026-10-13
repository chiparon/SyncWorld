import assert from 'node:assert/strict';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { openRegistry } from '../../src/postoffice/registry.ts';
import type { AgentRecord, Registry, TurnRecord } from '../../src/schema/types.ts';

function temporaryDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'syncw-registry-'));
  t.after(() => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function agent(name = 'engineer-1', status: AgentRecord['status'] = 'idle'): AgentRecord {
  const repo = join(tmpdir(), 'registry-fixture-repo');
  return {
    name,
    role: 'engineer',
    brief: 'Implement the assigned task.',
    task: { goal: 'Test persistence', acceptance: ['Records survive reopening'] },
    engine: 'codex',
    hired_by: 'scheduler',
    repo,
    base: 'a'.repeat(40),
    branch: `syncw/${name}`,
    worktree: join(`${repo}.worktrees`, name),
    status,
    turns: [],
    queued_messages: [],
    created_at: '2026-10-13T00:00:00.000Z',
  };
}

function turn(number = 1): TurnRecord {
  return {
    input: 'Do the task.',
    result: null,
    facts: {
      turn: number,
      started_at: '2026-10-13T00:00:00.000Z',
      finished_at: '2026-10-13T00:00:01.000Z',
      duration_ms: 1000,
      exit_code: 1,
      files_touched: ['example.ts'],
      timed_out: false,
      cancelled: false,
    },
    reported: false,
  };
}

function saved(registry: Registry): AgentRecord[] {
  return JSON.parse(readFileSync(join(registry.runDir, 'agents.json'), 'utf8'));
}

test('a new run has a local-time ID, an absolute directory, and empty state', (t) => {
  const runsDir = join(temporaryDirectory(t), 'runs');
  const before = new Date();
  const registry = openRegistry({ runsDir: relative(process.cwd(), runsDir) });
  const after = new Date();

  assert.match(registry.runId, /^\d{8}-\d{6}-[a-z0-9]{4}$/);
  const stamp = registry.runId.slice(0, 15);
  const localDate = new Date(
    Number(stamp.slice(0, 4)), Number(stamp.slice(4, 6)) - 1, Number(stamp.slice(6, 8)),
    Number(stamp.slice(9, 11)), Number(stamp.slice(11, 13)), Number(stamp.slice(13, 15)),
  );
  assert.ok(localDate.getTime() >= Math.floor(before.getTime() / 1000) * 1000);
  assert.ok(localDate.getTime() <= after.getTime());
  assert.equal(registry.runDir, join(runsDir, registry.runId));
  assert.ok(isAbsolute(registry.runDir));
  assert.ok(statSync(registry.runDir).isDirectory());
  assert.deepEqual(saved(registry), []);

  const directory = join(registry.runDir, 'engineer-1');
  assert.equal(existsSync(directory), false);
  assert.equal(registry.agentDir('engineer-1'), directory);
  assert.equal(registry.agentDir('engineer-1'), directory);
  assert.ok(statSync(directory).isDirectory());
  assert.notEqual(openRegistry({ runsDir }).runId, registry.runId);
});

test('records and turns survive reopening the same run', (t) => {
  const runsDir = temporaryDirectory(t);
  const registry = openRegistry({ runsDir });
  const record = agent();
  registry.add(record);
  assert.deepEqual(saved(registry), [record]);

  const first = turn();
  const second = turn(2);
  registry.appendTurn(record.name, first);
  const updated = registry.appendTurn(record.name, second);
  assert.deepEqual(updated.turns, [first, second]);
  assert.deepEqual(saved(registry), [updated]);

  const reopened = openRegistry({ runsDir, reopenLatest: true });
  assert.equal(reopened.runId, registry.runId);
  assert.equal(reopened.runDir, registry.runDir);
  assert.deepEqual(reopened.get(record.name), updated);
  assert.throws(() => registry.appendTurn('missing', first), /Unknown agent "missing"/);
});

test('atomic updates replace the old file and leave pretty, valid JSON without temporary files', (t) => {
  const registry = openRegistry({ runsDir: temporaryDirectory(t) });
  registry.add(agent());
  const statePath = join(registry.runDir, 'agents.json');
  const previousPath = join(registry.runDir, 'previous.json');
  linkSync(statePath, previousPath);
  try {
    registry.update('engineer-1', { status: 'running' });
    // A hard link keeps the old file readable without Windows locking it against rename.
    assert.equal(JSON.parse(readFileSync(previousPath, 'utf8'))[0].status, 'idle');
    assert.equal(saved(registry)[0]?.status, 'running');
  } finally {
    rmSync(previousPath);
  }
  for (const status of ['idle', 'closed'] as const) {
    registry.update('engineer-1', { status });
    const text = readFileSync(statePath, 'utf8');
    assert.equal(text, `${JSON.stringify(registry.list(), null, 2)}\n`);
    assert.deepEqual(JSON.parse(text), registry.list());
  }
  assert.deepEqual(readdirSync(registry.runDir), ['agents.json']);
});

test('reopenLatest interrupts only queued and running agents, persists, and logs their names', (t) => {
  const runsDir = temporaryDirectory(t);
  const registry = openRegistry({ runsDir });
  const statuses: AgentRecord['status'][] = ['running', 'queued', 'idle', 'cancelled', 'interrupted', 'closed'];
  statuses.forEach((status, index) => registry.add(agent(`engineer-${index + 1}`, status)));

  const reopened = openRegistry({ runsDir, reopenLatest: true });
  assert.deepEqual(reopened.list().map((record) => record.status), [
    'interrupted', 'interrupted', 'idle', 'cancelled', 'interrupted', 'closed',
  ]);
  assert.deepEqual(saved(reopened), reopened.list());
  const event = JSON.parse(readFileSync(join(reopened.runDir, 'log.jsonl'), 'utf8').trim());
  assert.equal(event.event, 'registry.reopened');
  assert.deepEqual(event.interrupted, ['engineer-1', 'engineer-2']);
  assert.equal(new Date(event.ts).toISOString(), event.ts);
});

test('reopenLatest selects by name and ignores directories without state and ordinary files', (t) => {
  const runsDir = temporaryDirectory(t);
  const newer = '20261013-120000-aaaa';
  const older = '20261012-120000-zzzz';
  for (const [name, record] of [[newer, agent('engineer-2')], [older, agent('engineer-1')]] as const) {
    mkdirSync(join(runsDir, name));
    writeFileSync(join(runsDir, name, 'agents.json'), JSON.stringify([record]));
  }
  mkdirSync(join(runsDir, '20261014-120000-aaaa'));
  writeFileSync(join(runsDir, '20261015-120000-aaaa'), 'not a directory');

  const registry = openRegistry({ runsDir, reopenLatest: true });
  assert.equal(registry.runId, newer);
  assert.deepEqual(registry.list(), [agent('engineer-2')]);
  const event = JSON.parse(readFileSync(join(registry.runDir, 'log.jsonl'), 'utf8').trim());
  assert.deepEqual(event.interrupted, []);
});

test('reopenLatest starts a new run when no previous state exists', (t) => {
  const runsDir = join(temporaryDirectory(t), 'runs');
  const registry = openRegistry({ runsDir, reopenLatest: true });
  assert.deepEqual(saved(registry), []);
  assert.match(registry.runId, /^\d{8}-\d{6}-[a-z0-9]{4}$/);
});

test('allocateName fills gaps, does not reserve names, and never reuses closed names', (t) => {
  const runsDir = temporaryDirectory(t);
  const registry = openRegistry({ runsDir });
  registry.add(agent('engineer-2'));
  assert.equal(registry.allocateName('engineer'), 'engineer-1');
  assert.equal(registry.allocateName('engineer'), 'engineer-1');
  assert.equal(registry.list().length, 1);
  registry.add(agent('engineer-1', 'closed'));
  registry.update('engineer-2', { status: 'closed' });
  assert.equal(registry.allocateName('engineer'), 'engineer-3');
  assert.equal(registry.allocateName('reviewer'), 'reviewer-1');
  assert.equal(openRegistry({ runsDir, reopenLatest: true }).allocateName('engineer'), 'engineer-3');
});

test('duplicate names are rejected without overwriting existing records', (t) => {
  const registry = openRegistry({ runsDir: temporaryDirectory(t) });
  registry.add(agent());
  assert.throws(() => registry.add(agent('engineer-1', 'closed')), /engineer-1.*already exists/);
  assert.deepEqual(saved(registry), [agent()]);
});

test('update shallow-merges and persists, and rejects unknown names and renames', (t) => {
  const registry = openRegistry({ runsDir: temporaryDirectory(t) });
  registry.add(agent());
  const updated = registry.update('engineer-1', { task: { goal: 'Replacement task' }, status: 'running' });
  assert.deepEqual(updated, { ...agent(), task: { goal: 'Replacement task' }, status: 'running' });
  assert.deepEqual(saved(registry), [updated]);
  assert.throws(() => registry.update('missing', { status: 'idle' }), /Unknown agent "missing"/);
  // Structural typing can pass a name even though the patch contract omits it.
  const rename = { name: 'engineer-9', status: 'idle' as const };
  assert.throws(() => registry.update('engineer-1', rename), /Cannot rename agent/);
  assert.deepEqual(saved(registry), [updated]);
  assert.equal(registry.get('engineer-9'), undefined);
});

test('get and list return deep copies, including nested tasks and turns', (t) => {
  const registry = openRegistry({ runsDir: temporaryDirectory(t) });
  registry.add(agent());
  registry.appendTurn('engineer-1', turn());
  const expected = saved(registry);
  const record = registry.get('engineer-1');
  assert.ok(record);
  record.task.acceptance?.push('External mutation');
  record.turns[0]!.facts.files_touched.push('injected.ts');
  const list = registry.list();
  list[0]!.queued_messages.push('External mutation');
  list.pop();
  assert.deepEqual(registry.list(), expected);
  assert.deepEqual(saved(registry), expected);
  assert.equal(registry.get('missing'), undefined);
});

test('mutation inputs and returned records also cannot bypass persistence', (t) => {
  const registry = openRegistry({ runsDir: temporaryDirectory(t) });
  const record = agent();
  registry.add(record);
  record.task.goal = 'External mutation';
  const messages = ['Follow up'];
  const updated = registry.update(record.name, { queued_messages: messages });
  messages.push('External mutation');
  updated.task.goal = 'External mutation';
  const appendedTurn = turn();
  const appended = registry.appendTurn(record.name, appendedTurn);
  appendedTurn.facts.files_touched.push('injected.ts');
  appended.turns.length = 0;
  assert.deepEqual(registry.list(), saved(registry));
  assert.equal(registry.get(record.name)?.task.goal, 'Test persistence');
  assert.deepEqual(registry.get(record.name)?.queued_messages, ['Follow up']);
  assert.deepEqual(registry.get(record.name)?.turns, [turn()]);
});

test('each log call appends a single JSON line with an ISO timestamp and event data', (t) => {
  const registry = openRegistry({ runsDir: temporaryDirectory(t) });
  registry.log('agent.started', { name: 'engineer-1', prompt: 'Line one\nLine two: "你好"' });
  registry.log('agent.finished', { details: { successful: true } });
  registry.log('run.finished');

  const text = readFileSync(join(registry.runDir, 'log.jsonl'), 'utf8');
  assert.ok(text.endsWith('\n'));
  const events = text.trimEnd().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.event), ['agent.started', 'agent.finished', 'run.finished']);
  for (const event of events) assert.equal(new Date(event.ts).toISOString(), event.ts);
  assert.equal(events[0].prompt, 'Line one\nLine two: "你好"');
  assert.deepEqual(events[1].details, { successful: true });
});
