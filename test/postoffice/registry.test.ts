import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
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
import { syncBuiltinESMExports } from 'node:module';
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

function seedRun(runsDir: string, id: string, agents: AgentRecord[]): string {
  const runDir = join(runsDir, id);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'agents.json'), JSON.stringify(agents));
  return runDir;
}

async function liveOwner(t: TestContext, directory: string) {
  const script = join(directory, 'owner.cjs');
  writeFileSync(script, "setInterval(() => {}, 60_000); process.send('ready');");
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });
  await once(child, 'message');
  assert.ok(child.pid);
  return child;
}

function ownerClaim(runDir: string, pid: number): string {
  const file = join(runDir, `owner-${pid}.json`);
  writeFileSync(file, JSON.stringify({ pid, started_at: '2026-10-13T00:00:00.000Z' }));
  return file;
}

test('opening, reading and allocating a name are lazy; the first add creates state and a claim', (t) => {
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
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.get('missing'), undefined);
  assert.equal(registry.allocateName('engineer'), 'engineer-1');
  assert.equal(registry.allocateName('engineer', new Set(['engineer-1'])), 'engineer-2');
  assert.equal(existsSync(runsDir), false);
  registry.add(agent());
  assert.deepEqual(saved(registry), [agent()]);
  const claim = JSON.parse(readFileSync(join(registry.runDir, `owner-${process.pid}.json`), 'utf8'));
  assert.equal(claim.pid, process.pid);
  assert.equal(new Date(claim.started_at).toISOString(), claim.started_at);

  const directory = join(registry.runDir, 'engineer-1');
  assert.equal(existsSync(directory), false);
  assert.equal(registry.agentDir('engineer-1'), directory);
  assert.equal(registry.agentDir('engineer-1'), directory);
  assert.ok(statSync(directory).isDirectory());
  assert.notEqual(openRegistry({ runsDir, mode: 'new' }).runId, registry.runId);
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

  registry.close();
  const reopened = openRegistry({ runsDir });
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
  assert.deepEqual(readdirSync(registry.runDir).sort(), ['agents.json', `owner-${process.pid}.json`].sort());
});

test('continuing interrupts only queued and running agents, persists, and logs their names', (t) => {
  const runsDir = temporaryDirectory(t);
  const registry = openRegistry({ runsDir });
  const statuses: AgentRecord['status'][] = ['running', 'queued', 'idle', 'cancelled', 'interrupted', 'closed'];
  statuses.forEach((status, index) => registry.add(agent(`engineer-${index + 1}`, status)));
  registry.close();

  const reopened = openRegistry({ runsDir, mode: 'continue' });
  assert.deepEqual(reopened.list().map((record) => record.status), [
    'interrupted', 'interrupted', 'idle', 'cancelled', 'interrupted', 'closed',
  ]);
  assert.deepEqual(saved(reopened), reopened.list());
  const event = JSON.parse(readFileSync(join(reopened.runDir, 'log.jsonl'), 'utf8').trim());
  assert.equal(event.event, 'registry.reopened');
  assert.deepEqual(event.interrupted, ['engineer-1', 'engineer-2']);
  assert.equal(new Date(event.ts).toISOString(), event.ts);
});

test('continue without a repo selects by name and ignores directories without state and ordinary files', (t) => {
  const runsDir = temporaryDirectory(t);
  const newer = '20261013-120000-aaaa';
  const older = '20261012-120000-zzzz';
  for (const [name, record] of [[newer, agent('engineer-2')], [older, agent('engineer-1')]] as const) {
    mkdirSync(join(runsDir, name));
    writeFileSync(join(runsDir, name, 'agents.json'), JSON.stringify([record]));
  }
  mkdirSync(join(runsDir, '20261014-120000-aaaa'));
  writeFileSync(join(runsDir, '20261015-120000-aaaa'), 'not a directory');

  const registry = openRegistry({ runsDir, mode: 'continue' });
  assert.equal(registry.runId, newer);
  assert.deepEqual(registry.list(), [agent('engineer-2')]);
  const event = JSON.parse(readFileSync(join(registry.runDir, 'log.jsonl'), 'utf8').trim());
  assert.deepEqual(event.interrupted, []);
});

test('continue starts a lazy new run when no previous state exists', (t) => {
  const runsDir = join(temporaryDirectory(t), 'runs');
  const registry = openRegistry({ runsDir, mode: 'continue' });
  assert.deepEqual(registry.list(), []);
  assert.equal(existsSync(runsDir), false);
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
  registry.add(agent('reviewer-1'));
  registry.close();
  assert.equal(openRegistry({ runsDir }).allocateName('engineer'), 'engineer-3');
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

for (const firstWrite of ['agentDir', 'log'] as const) {
  test(`${firstWrite} also creates a lazy run with state and a claim`, (t) => {
    const runsDir = join(temporaryDirectory(t), 'runs');
    const registry = openRegistry({ runsDir });
    assert.equal(existsSync(runsDir), false);
    if (firstWrite === 'agentDir') registry.agentDir('engineer-1');
    else registry.log('started');
    assert.deepEqual(saved(registry), []);
    assert.ok(existsSync(join(registry.runDir, `owner-${process.pid}.json`)));
  });
}

test('a fixed run id collision throws without changing the existing directory', (t) => {
  const runsDir = join(temporaryDirectory(t), 'runs');
  const registry = openRegistry({ runsDir });
  mkdirSync(registry.runDir, { recursive: true });
  const file = join(registry.runDir, 'agents.json');
  const original = JSON.stringify([agent('existing-1')]);
  writeFileSync(file, original);
  assert.throws(() => registry.add(agent()), /already exists.*Open a new registry.*retry/);
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.deepEqual(readdirSync(registry.runDir), ['agents.json']);
  assert.deepEqual(registry.list(), []);
});

test('continue selects this repo\'s newest run, ignoring newer other repos and older matching runs', (t) => {
  const runsDir = temporaryDirectory(t);
  const repo = join(runsDir, 'Repo');
  const older = seedRun(runsDir, '20261012-120000-aaaa', [{ ...agent('older-1', 'running'), repo }]);
  const selected = seedRun(runsDir, '20261013-120000-aaaa', [
    { ...agent('other-1', 'running'), repo: join(runsDir, 'Other') },
    { ...agent('selected-1', 'queued'), repo },
  ]);
  const newer = seedRun(runsDir, '20261014-120000-aaaa', [{ ...agent('newer-1', 'running'), repo: join(runsDir, 'Other') }]);
  const before = [older, newer].map((dir) => readFileSync(join(dir, 'agents.json'), 'utf8'));
  const resolvedRepo = join(repo, 'child', '..');
  const registry = openRegistry({ runsDir, repo: relative(process.cwd(), process.platform === 'win32' ? resolvedRepo.toUpperCase() : resolvedRepo) });
  assert.equal(registry.runDir, selected);
  assert.deepEqual(registry.list().map((record) => record.status), ['interrupted', 'interrupted']);
  assert.deepEqual([older, newer].map((dir) => readFileSync(join(dir, 'agents.json'), 'utf8')), before);
});

test('a closed latest run starts a new run instead of continuing an older unfinished run', (t) => {
  const runsDir = temporaryDirectory(t);
  seedRun(runsDir, '20261012-120000-aaaa', [agent('older-1', 'running')]);
  const latest = seedRun(runsDir, '20261013-120000-aaaa', [agent('latest-1', 'closed')]);
  const registry = openRegistry({ runsDir, repo: agent().repo });
  assert.deepEqual(registry.list(), []);
  assert.equal(existsSync(registry.runDir), false);
  assert.deepEqual(readdirSync(latest), ['agents.json']);
});

test('mode new ignores an unfinished run without claiming or interrupting it', (t) => {
  const runsDir = temporaryDirectory(t);
  const latest = seedRun(runsDir, '20261013-120000-aaaa', [agent('engineer-1', 'running')]);
  const before = readFileSync(join(latest, 'agents.json'), 'utf8');
  const registry = openRegistry({ runsDir, mode: 'new' });
  assert.deepEqual(registry.list(), []);
  assert.equal(existsSync(registry.runDir), false);
  assert.equal(readFileSync(join(latest, 'agents.json'), 'utf8'), before);
  assert.deepEqual(readdirSync(latest), ['agents.json']);
});

test('a live owner forces a new run and leaves its agents and claim untouched', async (t) => {
  const runsDir = temporaryDirectory(t);
  const child = await liveOwner(t, runsDir);
  seedRun(runsDir, '20261012-120000-aaaa', [agent('older-1', 'running')]);
  const latest = seedRun(runsDir, '20261013-120000-aaaa', [agent('engineer-1', 'running')]);
  const claim = ownerClaim(latest, child.pid!);
  const before = [join(latest, 'agents.json'), claim].map((file) => readFileSync(file, 'utf8'));
  const registry = openRegistry({ runsDir });
  assert.deepEqual(registry.list(), []);
  assert.equal(existsSync(registry.runDir), false);
  assert.deepEqual([join(latest, 'agents.json'), claim].map((file) => readFileSync(file, 'utf8')), before);
  assert.equal(existsSync(join(latest, `owner-${process.pid}.json`)), false);
  assert.equal(existsSync(join(latest, 'log.jsonl')), false);
});

test('a dead owner claim is removed and its run continued', async (t) => {
  const runsDir = temporaryDirectory(t);
  const child = await liveOwner(t, runsDir);
  const exited = once(child, 'exit');
  child.kill();
  await exited;
  assert.throws(() => process.kill(child.pid!, 0));
  const latest = seedRun(runsDir, '20261013-120000-aaaa', [agent('engineer-1', 'running')]);
  const stale = ownerClaim(latest, child.pid!);
  const registry = openRegistry({ runsDir });
  assert.equal(registry.runDir, latest);
  assert.equal(existsSync(stale), false);
  assert.equal(registry.get('engineer-1')?.status, 'interrupted');
  assert.ok(existsSync(join(latest, `owner-${process.pid}.json`)));
});

test('our own pid is not a live competing claim', (t) => {
  const runsDir = temporaryDirectory(t);
  const latest = seedRun(runsDir, '20261013-120000-aaaa', [agent()]);
  const own = ownerClaim(latest, process.pid);
  const registry = openRegistry({ runsDir });
  assert.equal(registry.runDir, latest);
  assert.ok(existsSync(own));
});

test('EPERM from a competing owner is treated as live', (t) => {
  const runsDir = temporaryDirectory(t);
  const latest = seedRun(runsDir, '20261013-120000-aaaa', [agent()]);
  const pid = process.pid + 1;
  const other = ownerClaim(latest, pid);
  t.mock.method(process, 'kill', (target: number, signal: number | string) => {
    assert.equal(target, pid);
    assert.equal(signal, 0);
    throw Object.assign(new Error('Access denied'), { code: 'EPERM' });
  });
  assert.deepEqual(openRegistry({ runsDir }).list(), []);
  assert.ok(existsSync(other));
  assert.equal(existsSync(join(latest, `owner-${process.pid}.json`)), false);
});

test('close removes only our claim, is idempotent, and leaves a never-written run absent', (t) => {
  const runsDir = join(temporaryDirectory(t), 'runs');
  const lazy = openRegistry({ runsDir });
  lazy.close();
  lazy.close();
  assert.equal(existsSync(runsDir), false);
  const registry = openRegistry({ runsDir });
  registry.add(agent());
  const other = ownerClaim(registry.runDir, process.pid + 1);
  const otherBefore = readFileSync(other, 'utf8');
  registry.close();
  registry.close();
  assert.equal(existsSync(join(registry.runDir, `owner-${process.pid}.json`)), false);
  assert.equal(readFileSync(other, 'utf8'), otherBefore);
  assert.deepEqual(saved(registry), [agent()]);
  assert.throws(() => registry.log('too-late'), /registry is closed.*Open a registry/);
});

test('a live claim appearing after our claim is written wins the race and our claim is removed', async (t) => {
  const runsDir = temporaryDirectory(t);
  const child = await liveOwner(t, runsDir);
  const latest = seedRun(runsDir, '20261013-120000-aaaa', [agent('engineer-1', 'running')]);
  const state = join(latest, 'agents.json');
  const before = readFileSync(state, 'utf8');
  const own = join(latest, `owner-${process.pid}.json`);
  const other = join(latest, `owner-${child.pid}.json`);
  const originalWrite = fs.writeFileSync;
  let raced = false;
  const mocked = t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
    originalWrite(...args);
    if (args[0] === own) {
      assert.ok(existsSync(own));
      originalWrite(other, JSON.stringify({ pid: child.pid, started_at: new Date().toISOString() }));
      raced = true;
    }
  });
  syncBuiltinESMExports();
  try {
    const registry = openRegistry({ runsDir });
    assert.ok(raced);
    assert.deepEqual(registry.list(), []);
    assert.equal(existsSync(registry.runDir), false);
    assert.equal(existsSync(own), false);
    assert.ok(existsSync(other));
    assert.equal(readFileSync(state, 'utf8'), before);
    assert.equal(existsSync(join(latest, 'log.jsonl')), false);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test('broken state surfaces an error instead of starting or continuing another run', (t) => {
  const runsDir = temporaryDirectory(t);
  seedRun(runsDir, '20261012-120000-aaaa', [agent()]);
  const latest = seedRun(runsDir, '20261013-120000-aaaa', []);
  for (const text of ['{', '{}', '[null]']) {
    writeFileSync(join(latest, 'agents.json'), text);
    assert.throws(() => openRegistry({ runsDir, repo: agent().repo }), /Repair or restore/);
    assert.deepEqual(readdirSync(latest), ['agents.json']);
  }
});
