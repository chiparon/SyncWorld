import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { createPostOffice } from '../../src/postoffice/core.ts';
import { buildFirstPrompt, buildFollowUpPrompt } from '../../src/postoffice/prompt.ts';
import { openRegistry } from '../../src/postoffice/registry.ts';
import type {
  AgentRecord, Engine, EngineTurnOutcome, EngineTurnRequest, PostOffice, Registry,
  RunningTurn, TurnRecord, Worktrees,
} from '../../src/schema/types.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'lifecycle operation must finish within three seconds');
    await sleep(5);
  }
}

function temporaryDirectory(t: TestContext): string {
  const parent = dirname(fileURLToPath(import.meta.url));
  const root = mkdtempSync(join(parent, '.lifecycle-'));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(parent));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function previousTurn(): TurnRecord {
  return {
    input: 'Original task', result: null, reported: true,
    facts: {
      turn: 1, started_at: '2026-10-15T00:00:00.000Z', finished_at: '2026-10-15T00:00:01.000Z',
      duration_ms: 1000, exit_code: 0, files_touched: [], timed_out: false, cancelled: false,
    },
  };
}

function agent(root: string, patch: Partial<AgentRecord> = {}): AgentRecord {
  return {
    name: 'custom-1', role: 'custom', brief: 'Review the lifecycle.', task: { goal: 'Original task' },
    engine: 'codex', hired_by: 'scheduler', repo: join(root, 'repo'), base: 'a'.repeat(40),
    branch: 'syncw/custom-1', worktree: join(root, 'worktrees', 'custom-1'),
    status: 'idle', session_id: 'saved-session', turns: [previousTurn()], queued_messages: [],
    created_at: '2026-10-15T00:00:00.000Z', ...patch,
  };
}

function saved(registry: Registry): AgentRecord[] {
  return JSON.parse(readFileSync(join(registry.runDir, 'agents.json'), 'utf8')) as AgentRecord[];
}

// The real registry exercises durability. Controlled engine/commit completion makes
// the scheduling boundaries deterministic, without depending on subprocess speed.
function fixture(t: TestContext) {
  const parent = dirname(fileURLToPath(import.meta.url));
  const root = mkdtempSync(join(parent, '.lifecycle-'));
  const runsDir = join(root, 'runs');
  let registry = openRegistry({ runsDir, repo: join(root, 'repo') });
  const registries = [registry];
  const started: { request: EngineTurnRequest; handle: RunningTurn; finish: () => void; cancellations: number }[] = [];
  const engine: Engine = {
    kind: 'codex',
    startTurn(request) {
      const completed = deferred<EngineTurnOutcome>();
      const session_id = request.session_id ?? `session-${started.length + 1}`;
      let ended = false;
      const finish = (cancelled: boolean) => {
        if (ended) return;
        ended = true;
        completed.resolve({
          session_id, exit_code: cancelled ? null : 0, result: null,
          files_touched: [], timed_out: false, cancelled,
        });
      };
      const entry = {
        request, cancellations: 0, finish: () => { finish(false); },
        handle: {
          sessionId: Promise.resolve(session_id), done: completed.promise,
          cancel() { entry.cancellations++; finish(true); },
        },
      };
      started.push(entry);
      return entry.handle;
    },
  };
  const worktrees: Worktrees = {
    async usedNames() { return new Set(); },
    async create(_repo, name) {
      const worktree = join(root, 'worktrees', name);
      mkdirSync(worktree, { recursive: true });
      return { branch: `syncw/${name}`, worktree, base: 'a'.repeat(40) };
    },
    async commitAll() { return undefined; },
    async remove() {},
  };
  const offices: PostOffice[] = [];
  function openOffice() {
    const office = createPostOffice({
      registry, engine, worktrees, roles_dir: root, default_repo: join(root, 'repo'),
      result_schema_path: fileURLToPath(new URL('../../src/schema/result.schema.json', import.meta.url)),
      limits: { max_parallel: 1 },
    });
    offices.push(office);
    return office;
  }
  const office = openOffice();
  t.after(async () => {
    // Also finish handles missed by a broken shutdown, so failing probes cannot leak work.
    for (const entry of started) entry.finish();
    for (const current of offices) await current.shutdown();
    await until(() => offices.every((current) => current.listAgents().every((record) => record.status !== 'running')));
    for (const current of registries) current.close();
    assert.equal(dirname(resolve(root)), resolve(parent));
    rmSync(root, { recursive: true, force: true });
  });
  function reopen() {
    registry.close();
    registry = openRegistry({ runsDir, repo: join(root, 'repo') });
    registries.push(registry);
    return { registry, office: openOffice() };
  }
  return { root, runsDir, registry, engine, worktrees, started, office, reopen };
}

test('a prompt write failure discards undelivered messages before the follow-up starts', async (t) => {
  const f = fixture(t);
  f.registry.add(agent(f.root, { status: 'cancelled', queued_messages: ['Oldest retained message.'] }));
  // A directory at the prompt filename produces a real filesystem write failure.
  const blockedPrompt = join(f.registry.agentDir('custom-1'), 'turn-2.prompt.md');
  mkdirSync(blockedPrompt);
  await f.office.sendMessage({ to: 'custom-1', text: 'Second retained message.' });
  await until(() => f.registry.get('custom-1')!.status === 'idle');
  assert.equal(f.started.length, 0, 'no engine received the messages');
  assert.match(f.registry.get('custom-1')!.turns[1]!.facts.error!, /Cannot run turn:/);
  await f.office.shutdown();
  const next = f.reopen();
  await next.office.sendMessage({ to: 'custom-1', text: 'Retry after restart.' });
  assert.equal(f.started.length, 1);
  assert.equal(f.started[0]!.request.prompt, buildFollowUpPrompt([
    'Oldest retained message.', 'Second retained message.', 'Retry after restart.',
  ], 'scheduler'), 'a failed prompt write must not acknowledge messages the engine never received');
});

test('continue reopens an all-closed run when the previous owner finishes between selection and claim', (t) => {
  const root = temporaryDirectory(t);
  const runsDir = join(root, 'runs');
  const runDir = join(runsDir, '20261015-000000-aaaa');
  mkdirSync(runDir, { recursive: true });
  const state = join(runDir, 'agents.json');
  const record = agent(root, { status: 'running' });
  writeFileSync(state, JSON.stringify([record]));
  const write = fs.writeFileSync;
  let raced = false;
  // Deterministically schedule the previous owner's last save/release after
  // candidate selection, before the new owner publishes its claim.
  const mocked = t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
    if (args[0] === join(runDir, `owner-${process.pid}.json`)) {
      write(state, JSON.stringify([{ ...record, status: 'closed' }]));
      raced = true;
    }
    return write(...args);
  });
  syncBuiltinESMExports();
  let registry: Registry;
  try {
    registry = openRegistry({ runsDir, repo: record.repo });
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  t.after(() => { registry.close(); });
  assert.equal(raced, true);
  assert.notEqual(registry.runDir, runDir, 'a latest run with no non-closed agents requires a new run');
  assert.equal(existsSync(registry.runDir), false, 'the replacement run should remain lazy');
});

test('shutdown begun during auto-commit rejects existing waits and awaits persistence exactly once', async (t) => {
  const f = fixture(t);
  const committing = deferred<void>();
  const release = deferred<void>();
  let commits = 0;
  f.worktrees.commitAll = async () => {
    commits++;
    committing.resolve();
    await release.promise;
    return { commit: 'b'.repeat(40), diff_stat: 'partial.txt | 1 +' };
  };
  try {
    const spawned = await f.office.spawnAgent({ brief: 'Role', task: { goal: 'Work' } });
    const waiting = assert.rejects(f.office.wait({ agents: [spawned.name] }), /shutting down/);
    f.started[0]!.finish();
    await committing.promise;
    await f.office.sendMessage({ to: spawned.name, text: 'Keep this while committing.' });
    const stopping = f.office.shutdown();
    const again = f.office.shutdown();
    assert.equal(stopping, again);
    let resolved = false;
    void stopping.then(() => { resolved = true; });
    await waiting;
    await Promise.resolve();
    assert.equal(resolved, false);
    await assert.rejects(f.office.wait({ timeout_s: 0 }), /shutting down/);
    await assert.rejects(f.office.sendMessage({ to: spawned.name, text: 'Too late' }), /shutting down/);
    await assert.rejects(f.office.spawnAgent({ brief: 'Role', task: { goal: 'Too late' } }), /shutting down/);
    release.resolve();
    await stopping;
    const record = saved(f.registry)[0]!;
    assert.equal(commits, 1);
    assert.equal(record.status, 'interrupted');
    assert.equal(record.turns[0]!.reported, false);
    assert.equal(record.turns[0]!.facts.commit, 'b'.repeat(40));
    assert.match(record.turns[0]!.facts.error!, /post office shut down/);
    assert.deepEqual(record.queued_messages, ['Keep this while committing.']);
    const next = f.reopen();
    assert.equal((await next.office.wait({ timeout_s: 0 })).finished.length, 1);
    assert.equal((await next.office.wait({ timeout_s: 0 })).finished.length, 0);
  } finally {
    release.resolve();
  }
});

test('shutdown during usedNames prevents worktree creation and settles serialized spawn calls', async (t) => {
  const f = fixture(t);
  const entered = deferred<void>();
  const release = deferred<void>();
  let creations = 0;
  f.worktrees.usedNames = async () => { entered.resolve(); await release.promise; return new Set(); };
  const create = f.worktrees.create;
  f.worktrees.create = async (...args) => { creations++; return create(...args); };
  const input = { brief: 'Role', task: { goal: 'Work' } };
  const first = assert.rejects(f.office.spawnAgent(input), /shutting down/);
  const second = assert.rejects(f.office.spawnAgent(input), /shutting down/);
  try {
    await entered.promise;
    const stopping = f.office.shutdown();
    release.resolve();
    await Promise.all([first, second, stopping]);
    assert.equal(creations, 0);
    assert.deepEqual(f.registry.list(), []);
    assert.equal(existsSync(f.runsDir), false);
  } finally {
    release.resolve();
  }
});

test('cancelled queued messages survive a disk reopen and precede messages sent after interruption', async (t) => {
  const f = fixture(t);
  f.registry.add(agent(f.root));
  const busy = await f.office.spawnAgent({ brief: 'Role', task: { goal: 'Hold the slot' } });
  assert.equal(busy.name, 'custom-2');
  await f.office.sendMessage({ to: 'custom-1', text: 'Before cancellation.' });
  await f.office.cancelAgent('custom-1');
  await f.office.sendMessage({ to: 'custom-1', text: 'After cancellation.' });
  await f.office.sendMessage({ to: 'custom-1', text: 'While queued again.' });
  await f.office.shutdown();
  const next = f.reopen();
  assert.equal(next.registry.runId, f.registry.runId);
  assert.equal(next.registry.get('custom-1')!.status, 'interrupted');
  assert.deepEqual(next.registry.get('custom-1')!.queued_messages,
    ['Before cancellation.', 'After cancellation.', 'While queued again.']);
  await next.office.sendMessage({ to: 'custom-1', text: 'After reopening.' });
  assert.equal(f.started[1]!.request.session_id, 'saved-session');
  assert.equal(f.started[1]!.request.prompt, buildFollowUpPrompt([
    'Before cancellation.', 'After cancellation.', 'While queued again.', 'After reopening.',
  ], 'scheduler'));
  f.started[1]!.finish();
  await until(() => next.registry.get('custom-1')!.status === 'idle');
  assert.deepEqual(saved(next.registry).find((entry) => entry.name === 'custom-1')!.queued_messages, []);
});

test('first-turn recovery after a disk reopen delivers the original task before all retained messages', async (t) => {
  const f = fixture(t);
  f.registry.add(agent(f.root, {
    status: 'queued', session_id: undefined, turns: [], queued_messages: ['Before restart.'],
  }));
  await f.office.shutdown();
  const next = f.reopen();
  const initial = next.registry.get('custom-1')!;
  assert.equal(initial.status, 'interrupted');
  await next.office.sendMessage({ to: initial.name, text: 'Recover first turn.' });
  assert.equal(f.started[0]!.request.prompt, buildFirstPrompt(initial));
  assert.equal(f.started[0]!.request.session_id, undefined);
  await next.office.sendMessage({ to: initial.name, text: 'While first turn runs.' });
  assert.deepEqual(saved(next.registry)[0]!.queued_messages,
    ['Before restart.', 'Recover first turn.', 'While first turn runs.']);
  f.started[0]!.finish();
  await until(() => f.started.length === 2);
  assert.equal(f.started[1]!.request.session_id, 'session-1');
  assert.equal(f.started[1]!.request.prompt, buildFollowUpPrompt([
    'Before restart.', 'Recover first turn.', 'While first turn runs.',
  ], 'scheduler'));
  f.started[1]!.finish();
  await until(() => next.registry.get(initial.name)!.status === 'idle');
  assert.equal(next.registry.get(initial.name)!.turns.length, 2);
});

for (const firstWrite of ['log', 'agentDir'] as const) {
  test(`${firstWrite} publishes the claim before agents.json and close forbids every later write`, (t) => {
    const root = temporaryDirectory(t);
    const runsDir = join(root, 'runs');
    const registry = openRegistry({ runsDir, mode: 'new' });
    assert.equal(existsSync(runsDir), false);
    const write = fs.writeFileSync;
    let observedStateWrite = false;
    const mocked = t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
      if (typeof args[0] === 'string' && /agents\..*\.tmp$/.test(args[0])) {
        observedStateWrite = true;
        assert.equal(existsSync(join(registry.runDir, `owner-${process.pid}.json`)), true);
      }
      return write(...args);
    });
    syncBuiltinESMExports();
    try {
      if (firstWrite === 'log') registry.log('first-write');
      else registry.agentDir('custom-1');
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(observedStateWrite, true);
    registry.add(agent(root));
    const before = readFileSync(join(registry.runDir, 'agents.json'), 'utf8');
    registry.close();
    registry.close();
    for (const writeAgain of [
      () => registry.add(agent(root, { name: 'custom-2' })),
      () => registry.update('custom-1', { status: 'closed' }),
      () => registry.appendTurn('custom-1', previousTurn()),
      () => registry.agentDir('custom-2'),
      () => registry.log('after-close'),
    ]) assert.throws(writeAgain, /registry is closed/);
    assert.equal(readFileSync(join(registry.runDir, 'agents.json'), 'utf8'), before);
    assert.equal(readdirSync(registry.runDir).some((name) => name.startsWith('owner-')), false);
  });
}

test('two processes that see each other claim the same run both give up without interrupting its agents', async (t) => {
  const root = temporaryDirectory(t);
  const runsDir = join(root, 'runs');
  const runDir = join(runsDir, '20261015-000000-aaaa');
  mkdirSync(runDir, { recursive: true });
  const state = join(runDir, 'agents.json');
  writeFileSync(state, JSON.stringify([agent(root, { status: 'running' })]));
  const before = readFileSync(state, 'utf8');
  const release = join(root, 'release-scans');
  const script = join(root, 'claim-racer.mjs');
  // Pause each child after it snapshots both owner files. PIDs are real, and
  // both children stay alive until the parent has inspected their decisions.
  writeFileSync(script, `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { join } from 'node:path';
    import { openRegistry } from ${JSON.stringify(new URL('../../src/postoffice/registry.ts', import.meta.url).href)};
    const [runsDir, runDir, release] = process.argv.slice(2);
    const read = fs.readdirSync;
    fs.readdirSync = function (...args) {
      const entries = read(...args);
      if (args[0] === runDir) {
        process.send({ phase: 'scanned', entries });
        const deadline = Date.now() + 5000;
        while (!fs.existsSync(release)) {
          if (Date.now() > deadline) throw new Error('Parent did not release owner scan');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      return entries;
    };
    syncBuiltinESMExports();
    // The first barrier ensures both claims exist before either snapshot.
    const write = fs.writeFileSync;
    fs.writeFileSync = function (...args) {
      const result = write(...args);
      if (args[0] === join(runDir, 'owner-' + process.pid + '.json')) {
        const deadline = Date.now() + 5000;
        while (read(runDir).filter(name => /^owner-\\d+\\.json$/.test(name)).length < 2) {
          if (Date.now() > deadline) throw new Error('Other process did not publish its claim');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      return result;
    };
    syncBuiltinESMExports();
    const registry = openRegistry({ runsDir });
    process.on('message', () => { registry.close(); process.exit(0); });
    process.send({ phase: 'opened', runDir: registry.runDir, onDisk: fs.existsSync(registry.runDir) });
  `);
  const children = [0, 1].map(() => spawn(process.execPath, [script, runsDir, runDir, release], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
  }));
  const messages: { phase: string; entries?: string[]; runDir?: string; onDisk?: boolean }[][] = [[], []];
  const errors: string[] = ['', ''];
  children.forEach((child, index) => {
    child.on('message', (message) => { messages[index]!.push(message as (typeof messages)[number][number]); });
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { errors[index] += chunk; });
  });
  try {
    await until(() => messages.every((events) => events.some((event) => event.phase === 'scanned')));
    for (const events of messages) {
      const scanned = events.find((event) => event.phase === 'scanned')!;
      for (const child of children) assert.ok(scanned.entries!.includes(`owner-${child.pid}.json`));
    }
    writeFileSync(release, 'go');
    await until(() => messages.every((events) => events.some((event) => event.phase === 'opened')));
    for (const events of messages) {
      const opened = events.find((event) => event.phase === 'opened')!;
      assert.notEqual(opened.runDir, runDir);
      assert.equal(opened.onDisk, false);
    }
    assert.equal(readFileSync(state, 'utf8'), before);
    assert.deepEqual(readdirSync(runDir), ['agents.json']);
    assert.deepEqual(errors, ['', '']);
  } finally {
    writeFileSync(release, 'cleanup');
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }));
  }
});
