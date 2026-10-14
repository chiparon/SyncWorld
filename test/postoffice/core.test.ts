import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createCodexEngine } from '../../src/engines/codex.ts';
import { createPostOffice, DEFAULT_LIMITS } from '../../src/postoffice/core.ts';
import { buildFirstPrompt, buildFollowUpPrompt } from '../../src/postoffice/prompt.ts';
import { openRegistry } from '../../src/postoffice/registry.ts';
import { createWorktrees } from '../../src/postoffice/worktrees.ts';
import type { AgentRecord, Engine, EngineTurnRequest, PostOfficeLimits, RunningTurn, TurnReport } from '../../src/schema/types.ts';

const execute = promisify(execFile);
const fake = fileURLToPath(new URL('../fake-codex/codex.ts', import.meta.url));
const schema = fileURLToPath(new URL('../../src/schema/result.schema.json', import.meta.url));

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'condition must become true within the test timeout');
    await sleep(10);
  }
}

async function git(repo: string, ...args: string[]): Promise<string> {
  return (await execute('git', ['-c', 'core.quotepath=false', '-C', repo, ...args], {
    encoding: 'utf8', windowsHide: true,
  })).stdout.trim();
}

async function fixture(t: TestContext, limits: Partial<PostOfficeLimits> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'syncw-core-'));
  const repo = join(root, '仓库 with spaces');
  const roles = join(root, 'roles');
  const home = join(root, 'sessions');
  const registry = openRegistry({ runsDir: join(root, 'runs') });
  const worktrees = createWorktrees();
  const started: { request: EngineTurnRequest; turn: RunningTurn }[] = [];
  const codex = createCodexEngine({ command: [process.execPath, fake], env: { ...process.env, FAKE_CODEX_HOME: home } });
  const engine: Engine = {
    kind: codex.kind,
    startTurn(request) {
      const number = registry.list().find((record) => record.worktree === request.cwd)!.turns.length + 1;
      assert.equal(readFileSync(join(dirname(request.result_path), `turn-${number}.prompt.md`), 'utf8'), request.prompt);
      const turn = codex.startTurn(request);
      started.push({ request, turn });
      return turn;
    },
  };
  const options = {
    registry, worktrees, engine, roles_dir: roles, default_repo: repo, result_schema_path: schema,
    limits,
  };
  const office = createPostOffice(options);
  const offices = [office];
  function restart() {
    const next = createPostOffice(options);
    offices.push(next);
    return next;
  }
  t.after(async () => {
    for (const current of offices) await current.shutdown();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(repo);
  mkdirSync(roles);
  writeFileSync(join(roles, 'engineer.md'), 'Implement carefully.');
  writeFileSync(join(roles, 'researcher.md'), 'Read and report.');
  await git(repo, 'init');
  await git(repo, 'config', 'user.name', 'Original Author');
  await git(repo, 'config', 'user.email', 'original@example.test');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  await git(repo, 'config', 'core.autocrlf', 'false');
  const hooks = join(repo, '.git', 'test-hooks');
  mkdirSync(hooks);
  await git(repo, 'config', 'core.hooksPath', hooks);
  writeFileSync(join(repo, 'initial.txt'), 'initial\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-m', 'Initial commit');
  const base = await git(repo, 'rev-parse', 'HEAD');

  async function drain(current = office): Promise<TurnReport[]> {
    const reports: TurnReport[] = [];
    for (;;) {
      const output = await current.wait({ timeout_s: 15 });
      reports.push(...output.finished);
      if (!output.pending.length) return reports;
      assert.ok(output.finished.length, 'agents must finish within the test timeout');
    }
  }
  return { root, repo, roles, home, hooks, base, registry, worktrees, engine, started, options, office, restart, drain };
}

test('spawn and wait persist the prompt, result, measured facts and an authored auto-commit', async (t) => {
  const f = await fixture(t);
  const before = Date.now();
  const agent = await f.office.spawnAgent({ role: 'engineer', brief: 'Use small modules.', task: { goal: 'Write a file.\nFAKE: write nested/note.txt hello' } });
  assert.equal(agent.name, 'engineer-1');
  assert.equal(agent.status, 'running');
  const record = f.registry.get(agent.name)!;
  assert.equal(record.brief, 'Implement carefully.\n\nUse small modules.');
  assert.equal(record.repo, resolve(f.repo));
  assert.equal(record.base, f.base);
  assert.equal(record.engine, 'codex');
  assert.equal(record.hired_by, 'scheduler');
  assert.ok(Date.parse(record.created_at) >= before);
  const output = await f.office.wait({});
  assert.deepEqual(output.pending, []);
  assert.equal(output.finished.length, 1);
  const report = output.finished[0]!;
  assert.equal(report.agent, agent.name);
  assert.equal(report.turn, 1);
  assert.equal(report.result?.status, 'done');
  assert.match(report.result!.summary, /^fake turn 1 of session /);
  assert.equal(report.facts.exit_code, 0);
  assert.equal(report.facts.error, undefined);
  assert.equal(report.facts.timed_out, false);
  assert.equal(report.facts.cancelled, false);
  assert.deepEqual(report.facts.files_touched, ['nested/note.txt']);
  assert.deepEqual(report.facts.usage, { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 });
  assert.ok(Date.parse(report.facts.started_at) >= before);
  assert.equal(report.facts.duration_ms, Date.parse(report.facts.finished_at) - Date.parse(report.facts.started_at));
  assert.ok(report.facts.commit);
  assert.match(report.facts.diff_stat!, /nested\/note.txt/);
  assert.equal(await git(agent.worktree, 'show', `${report.facts.commit}:nested/note.txt`), 'hello');
  assert.equal(await git(agent.worktree, 'show', '-s', '--format=%an%n%ae'), `${agent.name} (syncw)\n${agent.name}@syncw.local`);
  assert.equal(await git(agent.worktree, 'show', '-s', '--format=%B'), `${agent.name} 第 1 轮：${report.result!.summary}`);
  assert.equal(await git(agent.worktree, 'status', '--porcelain'), '');
  const saved = f.registry.get(agent.name)!;
  assert.equal(saved.turns[0]!.input, buildFirstPrompt(record));
  assert.equal(saved.turns[0]!.reported, true);
  assert.deepEqual(JSON.parse(readFileSync(join(f.registry.agentDir(agent.name), 'turn-1.json'), 'utf8')), report.result);
  const logs = readFileSync(join(f.registry.runDir, 'log.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(logs[0].event, 'agent.spawned');
  assert.equal(logs[1].event, 'turn.finished');
  assert.equal(logs[1].result_status, 'done');
  assert.deepEqual(await f.office.wait({ timeout_s: 0 }), { finished: [], pending: [] });
  const summary = f.office.listAgents()[0]!;
  assert.equal(summary.status, 'idle');
  assert.equal(summary.turns, 1);
  assert.equal(summary.running_for_s, undefined);
  assert.equal(summary.last_summary, report.result!.summary);
});

test('concurrent waiters report a turn exactly once and sendMessage resumes the same session', async (t) => {
  const f = await fixture(t);
  const agent = await f.office.spawnAgent({ brief: 'Custom role.', task: { goal: 'Start.\nFAKE: sleep 100' } });
  assert.equal(agent.name, 'custom-1');
  const waits = await Promise.all([f.office.wait({}), f.office.wait({ agents: [agent.name, agent.name] })]);
  assert.equal(waits.flatMap((output) => output.finished).length, 1);
  const session = f.registry.get(agent.name)!.session_id;
  assert.ok(session);
  const delivery = await f.office.sendMessage({ to: agent.name, text: 'Continue.\nFAKE: write second.txt resumed' });
  assert.equal(delivery.delivery, 'started');
  const [report] = await f.drain();
  assert.equal(report!.turn, 2);
  assert.equal(report!.result?.summary, `fake turn 2 of session ${session}`);
  assert.equal(f.registry.get(agent.name)!.session_id, session);
  assert.equal(f.started[1]!.request.session_id, session);
  assert.equal(f.started[1]!.request.result_path, join(f.registry.agentDir(agent.name), 'turn-2.json'));
  assert.deepEqual(await f.office.wait({}), { finished: [], pending: [] });
  const events = readFileSync(join(f.registry.agentDir(agent.name), 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.type === 'thread.started').length, 2);
  assert.ok(existsSync(join(f.registry.agentDir(agent.name), 'stderr.log')));
});

test('messages received while running form one follow-up and session ids persist before completion', async (t) => {
  const f = await fixture(t);
  const agent = await f.office.spawnAgent({ role: 'engineer', task: { goal: 'Start.\nFAKE: sleep 400' } });
  const session = await f.started[0]!.turn.sessionId;
  const saved = JSON.parse(readFileSync(join(f.registry.runDir, 'agents.json'), 'utf8'));
  assert.equal(saved[0].session_id, session);
  assert.equal(saved[0].turns.length, 0);
  const first = 'Check the parser.\nFAKE: write first.txt first';
  const second = 'Then check the queue.\nFAKE: write second.txt second';
  assert.equal((await f.office.sendMessage({ to: agent.name, text: first })).delivery, 'queued');
  assert.equal((await f.office.sendMessage({ to: agent.name, text: second })).delivery, 'queued');
  const summary = f.office.listAgents()[0]!;
  assert.equal(summary.queued_messages, 2);
  assert.ok(summary.running_for_s! >= 0);
  const reports = await f.drain();
  assert.deepEqual(reports.map((report) => report.turn), [1, 2]);
  const record = f.registry.get(agent.name)!;
  assert.equal(record.turns[1]!.input, buildFollowUpPrompt([first, second], 'scheduler'));
  assert.deepEqual(record.queued_messages, []);
  assert.equal(reports[1]!.result?.summary, `fake turn 2 of session ${session}`);
  assert.deepEqual(reports[1]!.facts.files_touched, ['first.txt', 'second.txt']);
});

test('max_parallel queues agents FIFO, including follow-ups, and counts auto-commit time', async (t) => {
  const f = await fixture(t, { max_parallel: 1 });
  const commitAll = f.worktrees.commitAll;
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  f.worktrees.commitAll = async (...args) => { await gate; return commitAll(...args); };
  try {
    const first = await f.office.spawnAgent({ role: 'engineer', task: { goal: 'First.' } });
    const second = await f.office.spawnAgent({ role: 'engineer', task: { goal: 'Second.' } });
    const third = await f.office.spawnAgent({ role: 'engineer', task: { goal: 'Third.' } });
    assert.equal(first.status, 'running');
    assert.equal(second.status, 'queued');
    assert.equal(third.status, 'queued');
    assert.equal(f.started.length, 1);
    assert.equal((await f.office.sendMessage({ to: second.name, text: 'Queued message.' })).delivery, 'queued');
    assert.equal((await f.office.sendMessage({ to: first.name, text: 'Follow-up.' })).delivery, 'queued');
    await f.started[0]!.turn.done;
    assert.equal(f.office.listAgents()[0]!.status, 'running');
    release();
    const reports = await f.drain();
    assert.deepEqual(reports.map((report) => [report.agent, report.turn]), [
      [first.name, 1], [second.name, 1], [third.name, 1], [first.name, 2], [second.name, 2],
    ]);
    assert.equal(f.registry.get(second.name)!.turns[1]!.input, buildFollowUpPrompt(['Queued message.'], 'scheduler'));
  } finally {
    release();
  }
});

test('max_agents includes closed agents and concurrent spawn calls cannot share a name or exceed it', async (t) => {
  const f = await fixture(t, { max_agents: 2 });
  const inputs = { role: 'engineer', task: { goal: 'Work.' } };
  const results = await Promise.allSettled([f.office.spawnAgent(inputs), f.office.spawnAgent(inputs), f.office.spawnAgent(inputs)]);
  const agents = results.filter((result) => result.status === 'fulfilled').map((result) => result.value);
  assert.deepEqual(agents.map((agent) => agent.name), ['engineer-1', 'engineer-2']);
  assert.equal(results[2]!.status, 'rejected');
  if (results[2]!.status === 'rejected') assert.match(String(results[2]!.reason), /max_agents \(2\)/);
  await f.drain();
  await f.office.closeAgent(agents[0]!.name, { delete_branch: true });
  await assert.rejects(f.office.spawnAgent(inputs), /max_agents \(2\).*closed agents.*close this run's remaining agents and restart the post office, or start it with --new-run/);
});

test('max_turns counts queued and running turns and allows bundled messages for the final turn', async (t) => {
  const f = await fixture(t, { max_parallel: 1, max_turns: 2 });
  const first = await f.office.spawnAgent({ brief: 'Role', task: { goal: 'Work.\nFAKE: sleep 300' } });
  await f.office.sendMessage({ to: first.name, text: 'One.\nFAKE: sleep 100' });
  await f.office.sendMessage({ to: first.name, text: 'Two.' });
  const firstResult = await f.office.wait({});
  assert.equal(firstResult.finished[0]!.turn, 1);
  assert.deepEqual(firstResult.pending, [first.name]);
  await assert.rejects(f.office.sendMessage({ to: first.name, text: 'Too many' }), /max_turns \(2\).*Spawn a new agent/);
  await f.drain();
  await assert.rejects(f.office.sendMessage({ to: first.name, text: 'Still too many' }), /max_turns \(2\)/);
  assert.equal(f.registry.get(first.name)!.turns.length, 2);

  const oneTurn = await fixture(t, { max_turns: 1, max_parallel: 1 });
  const active = await oneTurn.office.spawnAgent({ role: 'engineer', task: { goal: 'Work.\nFAKE: sleep 30000' } });
  const queued = await oneTurn.office.spawnAgent({ role: 'researcher', task: { goal: 'Work.' } });
  assert.equal(queued.status, 'queued');
  await assert.rejects(oneTurn.office.sendMessage({ to: active.name, text: 'No' }), /max_turns \(1\)/);
  await assert.rejects(oneTurn.office.sendMessage({ to: queued.name, text: 'No' }), /max_turns \(1\)/);
  await oneTurn.office.cancelAgent(active.name);
  await oneTurn.drain();
});

test('cancelling a running turn keeps its partial commit and stops automatic queued messages', async (t) => {
  const f = await fixture(t);
  const agent = await f.office.spawnAgent({ brief: 'Role', task: { goal: 'Wait.\nFAKE: write partial.txt partial\nFAKE: sleep 30000' } });
  await f.started[0]!.turn.sessionId;
  // The timeout gives the fake time to finish its write before cancellation.
  const check = await f.office.wait({ timeout_s: 0.1 });
  assert.deepEqual(check, { finished: [], pending: [agent.name] });
  assert.ok(existsSync(join(agent.worktree, 'partial.txt')));
  await f.office.sendMessage({ to: agent.name, text: 'Do not start automatically.' });
  await f.office.cancelAgent(agent.name);
  const [report] = await f.drain();
  assert.equal(report!.facts.cancelled, true);
  assert.equal(report!.facts.exit_code, null);
  assert.equal(report!.result, null);
  assert.ok(report!.facts.commit);
  assert.equal(await git(agent.worktree, 'show', '-s', '--format=%B'), `${agent.name} 第 1 轮：(no result)`);
  assert.equal(f.registry.get(agent.name)!.status, 'cancelled');
  assert.equal(f.started.length, 1);
  await f.office.cancelAgent(agent.name);
  assert.deepEqual(f.registry.get(agent.name)!.queued_messages, ['Do not start automatically.']);
  await f.office.sendMessage({ to: agent.name, text: 'Now deliver everything.' });
  await f.drain();
  assert.equal(f.registry.get(agent.name)!.turns[1]!.input,
    buildFollowUpPrompt(['Do not start automatically.', 'Now deliver everything.'], 'scheduler'));
  assert.deepEqual(f.registry.get(agent.name)!.queued_messages, []);
});

test('queued cancellation creates no turn, wakes waits and sendMessage restarts the first turn', async (t) => {
  const f = await fixture(t, { max_parallel: 1 });
  const first = await f.office.spawnAgent({ brief: 'Role', task: { goal: 'Wait.\nFAKE: sleep 30000' } });
  const second = await f.office.spawnAgent({ brief: 'Role', task: { goal: 'Queued.' } });
  assert.equal(second.status, 'queued');
  await assert.rejects(f.office.closeAgent(second.name), /cancel it first/);
  const waiter = f.office.wait({ agents: [second.name] });
  await f.office.cancelAgent(second.name);
  assert.deepEqual(await waiter, { finished: [], pending: [] });
  assert.deepEqual(f.registry.get(second.name)!.turns, []);
  assert.equal(f.registry.get(second.name)!.status, 'cancelled');
  assert.equal(f.started.length, 1);
  assert.equal(f.registry.get(second.name)!.session_id, undefined);
  assert.equal((await f.office.sendMessage({ to: second.name, text: 'Continue' })).delivery, 'queued');
  assert.deepEqual(f.registry.get(second.name)!.queued_messages, ['Continue']);
  await f.office.cancelAgent(first.name);
  await f.drain();
  assert.equal(f.started.length, 3);
  const record = f.registry.get(second.name)!;
  assert.equal(record.turns[0]!.input, buildFirstPrompt(record));
  assert.equal(record.turns[1]!.input, buildFollowUpPrompt(['Continue'], 'scheduler'));
  assert.deepEqual(record.queued_messages, []);
});

test('cancelled and interrupted agents resume their original session', async (t) => {
  const f = await fixture(t);
  const agent = await f.office.spawnAgent({ brief: 'Role', task: { goal: 'Wait.\nFAKE: sleep 30000' } });
  const session = await f.started[0]!.turn.sessionId;
  await f.office.cancelAgent(agent.name);
  await f.drain();
  assert.equal((await f.office.sendMessage({ to: agent.name, text: 'Resume after cancellation.' })).delivery, 'started');
  const [second] = await f.drain();
  assert.equal(second!.result?.summary, `fake turn 2 of session ${session}`);
  // This is the state restored by openRegistry after a post office restart.
  f.registry.update(agent.name, { status: 'interrupted' });
  await f.office.cancelAgent(agent.name);
  assert.equal(f.registry.get(agent.name)!.status, 'interrupted');
  assert.equal((await f.office.sendMessage({ to: agent.name, text: 'Resume after interruption.' })).delivery, 'started');
  const [third] = await f.drain();
  assert.equal(third!.result?.summary, `fake turn 3 of session ${session}`);
  await f.office.cancelAgent(agent.name);
  assert.equal(f.registry.get(agent.name)!.status, 'idle');
});

test('an idle agent follow-up queues behind an occupied slot and resumes when it becomes free', async (t) => {
  const f = await fixture(t, { max_parallel: 1 });
  const first = await f.office.spawnAgent({ brief: 'Role', task: { goal: 'Finish.' } });
  await f.drain();
  const session = f.registry.get(first.name)!.session_id;
  const busy = await f.office.spawnAgent({ role: 'engineer', task: { goal: 'Wait.\nFAKE: sleep 30000' } });
  assert.equal((await f.office.sendMessage({ to: first.name, text: 'Continue.' })).delivery, 'queued');
  assert.equal(f.registry.get(first.name)!.status, 'queued');
  assert.equal(f.started.length, 2);
  await f.office.cancelAgent(busy.name);
  const reports = await f.drain();
  assert.equal(reports.find((report) => report.agent === first.name)!.result?.summary, `fake turn 2 of session ${session}`);
});

for (const status of ['idle', 'cancelled', 'interrupted'] as const) {
  test(`messages to an ${status} agent stay durable until its queued follow-up starts, including after restart`, async (t) => {
    const f = await fixture(t, { max_parallel: 1 });
    const agent = await f.office.spawnAgent({ brief: 'Role', task: { goal: 'Finish.' } });
    await f.drain();
    f.registry.update(agent.name, { status });
    await f.office.spawnAgent({ brief: 'Role', task: { goal: 'Wait.\nFAKE: sleep 30000' } });
    const messages = ['Oldest message.', 'Second message.'];
    for (const text of messages) {
      assert.equal((await f.office.sendMessage({ to: agent.name, text })).delivery, 'queued');
    }
    function persisted() {
      const records = JSON.parse(readFileSync(join(f.registry.runDir, 'agents.json'), 'utf8')) as AgentRecord[];
      return records.find((record) => record.name === agent.name)!;
    }
    assert.equal(persisted().status, 'queued');
    assert.deepEqual(persisted().queued_messages, messages);
    assert.deepEqual(f.registry.get(agent.name)!.queued_messages, messages);
    await f.office.shutdown();
    assert.equal(persisted().status, 'interrupted');
    assert.deepEqual(persisted().queued_messages, messages);

    const next = f.restart();
    const startTurn = f.engine.startTurn;
    f.engine.startTurn = (request) => {
      assert.deepEqual(persisted().queued_messages, [...messages, 'Newest message.']);
      assert.equal(request.prompt, buildFollowUpPrompt([...messages, 'Newest message.'], 'scheduler'));
      return startTurn(request);
    };
    assert.equal((await next.sendMessage({ to: agent.name, text: 'Newest message.' })).delivery, 'started');
    assert.deepEqual(persisted().queued_messages, []);
    await f.drain(next);
    assert.equal(f.registry.get(agent.name)!.turns.length, 2);
  });
}

test('automatic follow-ups retain messages while queued and include later messages when their slot opens', async (t) => {
  const f = await fixture(t, { max_parallel: 1 });
  const commitAll = f.worktrees.commitAll;
  const gate = signal();
  f.worktrees.commitAll = async (...args) => { await gate.promise; return commitAll(...args); };
  try {
    const agent = await f.office.spawnAgent({ brief: 'Role', task: { goal: 'Finish.' } });
    const busy = await f.office.spawnAgent({ brief: 'Role', task: { goal: 'Wait.\nFAKE: sleep 30000' } });
    await f.office.sendMessage({ to: agent.name, text: 'First.' });
    gate.resolve();
    await f.office.wait({ agents: [agent.name] });
    assert.equal(f.registry.get(agent.name)!.status, 'queued');
    assert.deepEqual(f.registry.get(agent.name)!.queued_messages, ['First.']);
    await f.office.sendMessage({ to: agent.name, text: 'Second.' });
    await f.office.cancelAgent(busy.name);
    await f.drain();
    const record = f.registry.get(agent.name)!;
    assert.equal(record.turns.length, 2);
    assert.equal(record.turns[1]!.input, buildFollowUpPrompt(['First.', 'Second.'], 'scheduler'));
    assert.deepEqual(record.queued_messages, []);
  } finally {
    gate.resolve();
  }
});

test('shutdown interrupts running and queued agents, commits partial work and preserves unreported turns and messages', async (t) => {
  const f = await fixture(t, { max_parallel: 1 });
  const active = await f.office.spawnAgent({ brief: 'Role', task: { goal: 'Write then wait.\nFAKE: write partial.txt saved\nFAKE: sleep 30000' } });
  const queued = await f.office.spawnAgent({ brief: 'Role', task: { goal: 'First turn still needed.' } });
  await until(() => existsSync(join(active.worktree, 'partial.txt')));
  await f.office.sendMessage({ to: active.name, text: 'Retain this running message.' });
  await f.office.sendMessage({ to: queued.name, text: 'Retain this queued message.' });
  const waitRejected = assert.rejects(f.office.wait({}), /post office is shutting down/);
  const commitAll = f.worktrees.commitAll;
  const committing = signal();
  const gate = signal();
  f.worktrees.commitAll = async (...args) => {
    committing.resolve();
    await gate.promise;
    return commitAll(...args);
  };
  let cancellations = 0;
  const handle = f.started[0]!.turn;
  const cancel = handle.cancel;
  handle.cancel = () => { cancellations++; cancel(); };
  try {
    let resolved = false;
    const stopping = f.office.shutdown().then(() => { resolved = true; });
    const alsoStopping = f.office.shutdown();
    await waitRejected;
    await committing.promise;
    assert.equal(resolved, false, 'shutdown must await the auto-commit and turn record');
    assert.equal(cancellations, 1);
    assert.equal(f.registry.get(queued.name)!.status, 'interrupted');
    assert.deepEqual(f.registry.get(active.name)!.turns, []);
    await assert.rejects(f.office.spawnAgent({ brief: 'Role', task: { goal: 'No new work.' } }), /post office is shutting down/);
    await assert.rejects(f.office.sendMessage({ to: active.name, text: 'No new message.' }), /post office is shutting down/);
    await assert.rejects(f.office.wait({ timeout_s: 0 }), /post office is shutting down/);
    gate.resolve();
    await Promise.all([stopping, alsoStopping]);
    await f.office.shutdown();
    assert.equal(cancellations, 1);
    assert.equal(f.started.length, 1);
    const record = f.registry.get(active.name)!;
    assert.equal(record.status, 'interrupted');
    assert.deepEqual(record.queued_messages, ['Retain this running message.']);
    assert.equal(record.turns.length, 1);
    const turn = record.turns[0]!;
    assert.equal(turn.reported, false);
    assert.equal(turn.facts.cancelled, true);
    assert.match(turn.facts.error!, /The post office shut down during the turn\./);
    assert.ok(turn.facts.commit);
    assert.equal(await git(active.worktree, 'show', `${turn.facts.commit}:partial.txt`), 'saved');
    assert.deepEqual(f.registry.get(queued.name)!.turns, []);
    assert.deepEqual(f.registry.get(queued.name)!.queued_messages, ['Retain this queued message.']);
    await assert.rejects(f.office.wait({}), /post office is shutting down/);

    const next = f.restart();
    const report = await next.wait({ timeout_s: 0 });
    assert.deepEqual(report.finished, [{ agent: active.name, turn: 1, result: turn.result, facts: turn.facts }]);
    assert.deepEqual(report.pending, []);
    assert.deepEqual(await next.wait({ timeout_s: 0 }), { finished: [], pending: [] });
    const startTurn = f.engine.startTurn;
    f.engine.startTurn = (request) => {
      if (request.session_id === undefined) {
        assert.equal(request.prompt, buildFirstPrompt(f.registry.get(queued.name)!));
        assert.deepEqual(f.registry.get(queued.name)!.queued_messages, ['Retain this queued message.', 'Resume first turn.']);
      }
      return startTurn(request);
    };
    assert.equal((await next.sendMessage({ to: queued.name, text: 'Resume first turn.' })).delivery, 'started');
    await f.drain(next);
    const resumed = f.registry.get(queued.name)!;
    assert.equal(resumed.turns.length, 2);
    assert.equal(resumed.turns[1]!.input, buildFollowUpPrompt(['Retain this queued message.', 'Resume first turn.'], 'scheduler'));
    assert.deepEqual(resumed.queued_messages, []);
  } finally {
    gate.resolve();
  }
});

test('shutdown waits for an in-flight spawn and leaves its created agent interrupted', async (t) => {
  const f = await fixture(t);
  const create = f.worktrees.create;
  const created = signal();
  const gate = signal();
  f.worktrees.create = async (...args) => {
    const info = await create(...args);
    created.resolve();
    await gate.promise;
    return info;
  };
  try {
    const spawning = f.office.spawnAgent({ brief: 'Role', task: { goal: 'Do not start.' } });
    const queuedSpawn = assert.rejects(f.office.spawnAgent({ brief: 'Role', task: { goal: 'Do not create.' } }), /post office is shutting down/);
    await created.promise;
    const stopping = f.office.shutdown();
    gate.resolve();
    const agent = await spawning;
    await Promise.all([stopping, queuedSpawn]);
    assert.equal(agent.status, 'interrupted');
    assert.equal(f.registry.list().length, 1);
    assert.equal(f.registry.get(agent.name)!.status, 'interrupted');
    assert.deepEqual(f.registry.get(agent.name)!.turns, []);
    assert.equal(f.started.length, 0);
    await f.office.shutdown();
  } finally {
    gate.resolve();
  }
});

test('wait filters agents, times out with pending names, and returns immediately when nothing can finish', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.office.wait({}), { finished: [], pending: [] });
  const first = await f.office.spawnAgent({ brief: 'Role', task: { goal: 'Wait.\nFAKE: sleep 30000' } });
  const second = await f.office.spawnAgent({ role: 'researcher', task: { goal: 'Finish.' } });
  assert.deepEqual(await f.office.wait({ agents: [], timeout_s: 600 }), { finished: [], pending: [] });
  assert.deepEqual(await f.office.wait({ agents: [first.name], timeout_s: 0 }), { finished: [], pending: [first.name] });
  const filtered = f.office.wait({ agents: [first.name], timeout_s: 0.2 });
  const completed = await f.office.wait({ agents: [second.name] });
  assert.equal(completed.finished[0]!.agent, second.name);
  assert.deepEqual(await filtered, { finished: [], pending: [first.name] });
  assert.deepEqual(await f.office.wait({ agents: [second.name] }), { finished: [], pending: [] });
  await f.office.cancelAgent(first.name);
  await f.drain();
});

test('close rejects running agents, removes worktrees, optionally deletes branches and rejects later messages', async (t) => {
  const f = await fixture(t);
  const agent = await f.office.spawnAgent({ role: 'engineer', task: { goal: 'Wait.\nFAKE: sleep 30000' } });
  await assert.rejects(f.office.closeAgent(agent.name), /running.*cancel it first/);
  await f.office.cancelAgent(agent.name);
  await f.drain();
  await f.office.closeAgent(agent.name, { delete_branch: true });
  assert.equal(existsSync(agent.worktree), false);
  assert.equal(await git(f.repo, 'for-each-ref', '--format=%(refname)', `refs/heads/${agent.branch}`), '');
  assert.equal(f.registry.get(agent.name)!.status, 'closed');
  await assert.rejects(f.office.sendMessage({ to: agent.name, text: 'Continue' }), /closed/);
  await assert.rejects(f.office.cancelAgent(agent.name), /closed/);
  await f.office.closeAgent(agent.name);
  const keep = await f.office.spawnAgent({ role: 'engineer', task: { goal: 'Finish.' } });
  await f.drain();
  await f.office.closeAgent(keep.name);
  assert.equal(existsSync(keep.worktree), false);
  assert.equal(await git(f.repo, 'rev-parse', keep.branch), f.base);
  const events = readFileSync(join(f.registry.runDir, 'log.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.event === 'agent.closed').length, 2);
});

test('validation lists available roles and a failed worktree creation adds no registry record', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.office.spawnAgent({ brief: 'Role', task: { goal: '  ' } }), /goal.*non-empty/);
  await assert.rejects(f.office.spawnAgent({ task: { goal: 'Work' } }), /role or brief/);
  await assert.rejects(f.office.spawnAgent({ role: 'unknown', task: { goal: 'Work' } }), /Available roles: engineer, researcher/);
  await assert.rejects(f.office.spawnAgent({ role: '..\\engineer', task: { goal: 'Work' } }), /Unknown role/);
  await assert.rejects(f.office.spawnAgent({ role: 'engineer', base: 'no-such-base', task: { goal: 'Work' } }), /no-such-base/);
  assert.deepEqual(f.registry.list(), []);
  assert.equal(existsSync(join(f.registry.runDir, 'log.jsonl')), false);
  const agent = await f.office.spawnAgent({ role: 'engineer', repo: relative(process.cwd(), f.repo), base: f.base, task: { goal: 'Work' } });
  assert.equal(agent.name, 'engineer-1');
  assert.equal(f.registry.get(agent.name)!.repo, f.repo);
  await f.drain();
  await assert.rejects(f.office.sendMessage({ to: 'missing', text: 'Hello' }), /Unknown agent/);
  await assert.rejects(f.office.wait({ agents: ['missing'] }), /Unknown agent/);
  await assert.rejects(f.office.cancelAgent('missing'), /Unknown agent/);
  await assert.rejects(f.office.closeAgent('missing'), /Unknown agent/);
});

test('limits merge defaults and reject non-positive or non-finite values', async (t) => {
  const f = await fixture(t, { max_agents: 1 });
  assert.deepEqual(DEFAULT_LIMITS, { max_parallel: 4, max_agents: 12, max_turns: 10, turn_timeout_ms: 1_800_000 });
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof PostOfficeLimits)[]) {
    for (const value of [0, -1, NaN, Infinity]) {
      assert.throws(() => createPostOffice({ ...f.options, limits: { [key]: value } }), new RegExp(`${key} must be a positive finite number`));
    }
  }
  await f.office.spawnAgent({ brief: 'Role', task: { goal: 'Finish.' } });
  assert.equal(f.started[0]!.request.timeout_ms, DEFAULT_LIMITS.turn_timeout_ms);
  await f.drain();
});

test('engine timeout is recorded and leaves the agent idle', async (t) => {
  const f = await fixture(t, { max_parallel: 1, turn_timeout_ms: 200 });
  const first = await f.office.spawnAgent({ brief: 'Role', task: { goal: 'Wait.\nFAKE: sleep 30000' } });
  const timedOut = await f.office.wait({ agents: [first.name] });
  assert.equal(timedOut.finished[0]!.facts.timed_out, true);
  assert.equal(timedOut.finished[0]!.facts.cancelled, false);
  assert.equal(f.registry.get(first.name)!.status, 'idle');
});

test('an invalid result is recorded and a later turn can resume the session', async (t) => {
  const f = await fixture(t);
  const agent = await f.office.spawnAgent({ brief: 'Role', task: { goal: 'Work.\nFAKE: bad-result' } });
  const output = await f.office.wait({});
  assert.equal(output.finished[0]!.result, null);
  assert.match(output.finished[0]!.facts.error!, /Invalid JSON/);
  assert.equal(f.registry.get(agent.name)!.status, 'idle');
  await f.office.sendMessage({ to: agent.name, text: 'Continue.' });
  const [report] = await f.drain();
  assert.match(report!.result!.summary, /^fake turn 2/);
});

test('a rejecting commit hook appends its error without losing the engine result', async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.hooks, 'pre-commit'), '#!/bin/sh\nprintf "blocked by test hook\\n" >&2\nexit 1\n', { mode: 0o755 });
  const agent = await f.office.spawnAgent({ brief: 'Role', task: { goal: 'Write.\nFAKE: write changed.txt pending\nFAKE: exit 7' } });
  const [report] = await f.drain();
  assert.equal(report!.result?.status, 'done');
  assert.equal(report!.facts.exit_code, 7);
  assert.match(report!.facts.error!, /exited with code 7/);
  assert.match(report!.facts.error!, /Auto-commit failed:.*[\s\S]*blocked by test hook/);
  assert.equal(report!.facts.commit, undefined);
  assert.equal(f.registry.get(agent.name)!.status, 'idle');
});

test('unexpected start and persistence exceptions are recorded and release the running slot', async (t) => {
  const f = await fixture(t, { max_parallel: 1 });
  const startTurn = f.engine.startTurn;
  f.engine.startTurn = () => { throw new Error('unexpected launch failure'); };
  const first = await f.office.spawnAgent({ brief: 'Role', task: { goal: 'Try.' } });
  const [failed] = await f.drain();
  assert.equal(failed!.result, null);
  assert.match(failed!.facts.error!, /unexpected launch failure/);
  assert.equal(f.registry.get(first.name)!.status, 'idle');
  await assert.rejects(f.office.sendMessage({ to: first.name, text: 'Retry' }), /nothing to resume/);
  f.engine.startTurn = startTurn;
  const append = f.registry.appendTurn;
  let fail = true;
  f.registry.appendTurn = (name, turn) => {
    const saved = append(name, turn);
    if (fail) { fail = false; throw new Error('unexpected append failure'); }
    return saved;
  };
  const second = await f.office.spawnAgent({ brief: 'Role', task: { goal: 'Finish.' } });
  const [recovered] = await f.drain();
  assert.equal(recovered!.result?.status, 'done');
  assert.match(recovered!.facts.error!, /unexpected append failure/);
  assert.equal(f.registry.get(second.name)!.turns.length, 1);
  assert.equal(f.registry.get(second.name)!.status, 'idle');
  assert.match(readFileSync(join(f.registry.runDir, 'log.jsonl'), 'utf8'), /turn.error/);
});

test('a failed launch retains messages without automatically retrying and the next sendMessage delivers them', async (t) => {
  const f = await fixture(t, { max_turns: 4 });
  const agent = await f.office.spawnAgent({ brief: 'Role', task: { goal: 'Finish.' } });
  await f.drain();
  f.registry.update(agent.name, { queued_messages: ['Oldest message.'] });
  const startTurn = f.engine.startTurn;
  let attempts = 0;
  f.engine.startTurn = () => {
    attempts++;
    throw new Error('persistent launch failure');
  };
  await f.office.sendMessage({ to: agent.name, text: 'Second message.' });
  const reports = await f.drain();
  assert.equal(attempts, 1, 'a failure before the engine accepts the turn must not retry automatically');
  assert.equal(reports.length, 1);
  assert.match(reports[0]!.facts.error!, /persistent launch failure/);
  const record = f.registry.get(agent.name)!;
  assert.equal(record.status, 'idle');
  assert.equal(record.turns.length, 2);
  assert.equal(record.turns[1]!.reported, true);
  assert.deepEqual(record.queued_messages, ['Oldest message.', 'Second message.']);
  f.engine.startTurn = startTurn;
  await f.office.sendMessage({ to: agent.name, text: 'Retry now.' });
  await f.drain();
  assert.equal(f.registry.get(agent.name)!.turns[2]!.input,
    buildFollowUpPrompt(['Oldest message.', 'Second message.', 'Retry now.'], 'scheduler'));
  assert.deepEqual(f.registry.get(agent.name)!.queued_messages, []);
});

test('auto-commit messages use only the first 100 characters of the first summary line', async (t) => {
  const f = await fixture(t);
  const startTurn = f.engine.startTurn;
  f.engine.startTurn = (request) => {
    const running = startTurn(request);
    return {
      ...running,
      done: running.done.then((outcome) => ({
        ...outcome,
        result: { ...outcome.result!, summary: `${'x'.repeat(120)}\nSecond line` },
      })),
    };
  };
  const agent = await f.office.spawnAgent({ brief: 'Role', task: { goal: 'Write.\nFAKE: write summary.txt done' } });
  await f.drain();
  assert.equal(await git(agent.worktree, 'show', '-s', '--format=%B'), `${agent.name} 第 1 轮：${'x'.repeat(100)}`);
});
