import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

import { readOptions } from '../../src/postoffice/main.ts';
import type { AgentRecord, AgentSummary, SendMessageOutput, SpawnAgentOutput, WaitOutput } from '../../src/schema/types.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const entry = join(root, 'src', 'postoffice', 'main.ts');
const fake = join(root, 'test', 'fake-codex', 'codex.ts');
const execute = promisify(execFile);

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'syncw-main-'));
  t.after(() => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  });
  const env = {
    ...getDefaultEnvironment(),
    SYNCW_RUNS_DIR: join(directory, 'runs'),
    SYNCW_CODEX_COMMAND: JSON.stringify([process.execPath, fake]),
    FAKE_CODEX_HOME: join(directory, 'sessions'),
    SYNCW_MAX_PARALLEL: '1',
    SYNCW_MAX_AGENTS: '2',
    SYNCW_MAX_TURNS: '2',
    SYNCW_TURN_TIMEOUT_MS: '10000',
  };
  return { directory, env };
}

async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await execute('git', ['-C', repo, ...args], { windowsHide: true });
  return stdout.trim();
}

async function repository(directory: string): Promise<string> {
  const repo = join(directory, 'repo');
  const hooks = join(directory, 'empty hooks');
  mkdirSync(repo);
  mkdirSync(hooks);
  await git(repo, 'init');
  await git(repo, 'config', 'user.name', 'Test Scheduler');
  await git(repo, 'config', 'user.email', 'scheduler@example.test');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  await git(repo, 'config', 'core.autocrlf', 'false');
  await git(repo, 'config', 'core.hooksPath', hooks);
  await git(repo, 'commit', '--allow-empty', '-m', 'Initial commit');
  return repo;
}

async function until(check: () => boolean, description: string, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    assert.ok(Date.now() < deadline, description);
    await sleep(25);
  }
}

function records(runDir: string): AgentRecord[] {
  return JSON.parse(readFileSync(join(runDir, 'agents.json'), 'utf8')) as AgentRecord[];
}

function onlyRun(runsDir: string): string {
  const runs = readdirSync(runsDir);
  assert.equal(runs.length, 1);
  return join(runsDir, runs[0]!);
}

function assertUnclaimed(runDir: string): void {
  assert.deepEqual(readdirSync(runDir).filter((name) => /^owner-.*\.json$/.test(name)), []);
}

async function connectDirect(env: Record<string, string>, repo: string) {
  const child = spawn(process.execPath, [entry, '--repo', repo], {
    cwd: repo, env, windowsHide: true, stdio: 'pipe',
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.once('exit', (code, signal) => done({ code, signal }));
  });
  const client = new Client({ name: 'direct-scheduler', version: '1.0.0' });
  // This stream transport speaks the same JSON-RPC framing without owning or killing the child.
  const transport = new StdioServerTransport(child.stdout, child.stdin);
  async function close() {
    child.stdin.end();
    try {
      await until(() => child.exitCode !== null || child.signalCode !== null, 'stdio server did not exit');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      await client.close();
    }
  }
  try {
    await client.connect(transport);
  } catch (error) {
    await close();
    throw error;
  }
  return { child, client, exited, close, stderr: () => stderr };
}

async function connect(env: Record<string, string>, cwd: string, args: string[]) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, ...args],
    env,
    cwd,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const client = new Client({ name: 'test-scheduler', version: '1.0.0' });
  const errors: Error[] = [];
  client.onerror = (error) => { errors.push(error); };
  try {
    await client.connect(transport);
  } catch (error) {
    await client.close();
    throw new Error(`Cannot connect to the stdio server: ${stderr}`, { cause: error });
  }
  return { client, errors, stderr: () => stderr };
}

async function call<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(result.content.length, 1);
  const item = result.content[0];
  assert.ok(item?.type === 'text');
  return JSON.parse(item.text) as T;
}

test('importable options use the module root for runs and the working directory for the repo', () => {
  assert.deepEqual(readOptions([], {}), {
    repo: process.cwd(),
    runsDir: join(root, 'runs'),
    mode: 'continue',
    limits: {},
  });
});

test('options resolve CLI paths, new-run, and all four environment limits', () => {
  assert.deepEqual(readOptions(['--repo', 'relative repo', '--new-run'], {
    SYNCW_RUNS_DIR: 'relative runs',
    SYNCW_MAX_PARALLEL: '2',
    SYNCW_MAX_AGENTS: '3',
    SYNCW_MAX_TURNS: '4',
    SYNCW_TURN_TIMEOUT_MS: '5000',
  }), {
    repo: resolve('relative repo'),
    runsDir: resolve('relative runs'),
    mode: 'new',
    limits: { max_parallel: 2, max_agents: 3, max_turns: 4, turn_timeout_ms: 5000 },
  });
  assert.throws(() => readOptions(['--repo'], {}), /--repo/);
  assert.throws(() => readOptions(['--unknown'], {}), /--unknown/);
  assert.throws(() => readOptions(['--reopen'], {}), /Unknown option '--reopen'/);
  assert.throws(() => readOptions(['unexpected'], {}), /unexpected/);
});

test('every configured limit must be a positive decimal safe integer', () => {
  for (const name of ['SYNCW_MAX_PARALLEL', 'SYNCW_MAX_AGENTS', 'SYNCW_MAX_TURNS', 'SYNCW_TURN_TIMEOUT_MS']) {
    for (const value of ['', '0', '-1', '1.5', 'NaN', 'Infinity', '1e3', '9007199254740992']) {
      assert.throws(() => readOptions([], { [name]: value }), new RegExp(`${name} must be a positive integer`));
    }
  }
});

test('restarting continues the run and session until all agents are closed', { timeout: 45_000 }, async (t) => {
  const { directory, env } = fixture(t);
  const repo = join(directory, '仓库 with spaces');
  const hooks = join(directory, 'empty hooks');
  mkdirSync(repo);
  mkdirSync(hooks);
  await git(repo, 'init');
  await git(repo, 'config', 'user.name', 'Test Scheduler');
  await git(repo, 'config', 'user.email', 'scheduler@example.test');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  await git(repo, 'config', 'core.autocrlf', 'false');
  await git(repo, 'config', 'core.hooksPath', hooks);
  await git(repo, 'commit', '--allow-empty', '-m', 'Initial commit');

  // This cwd is neither the repository nor Syncw, so module assets must use import.meta.url.
  let connection = await connect(env, directory, ['--repo', repo]);
  let { client } = connection;
  let name: string;
  try {
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [
      'cancel_agent', 'close_agent', 'list_agents', 'send_message', 'spawn_agent', 'wait',
    ]);
    assert.equal(client.getInstructions(), readFileSync(join(root, 'roles', 'scheduler.md'), 'utf8'));

    const agent = await call<SpawnAgentOutput>(client, 'spawn_agent', {
      role: 'engineer',
      task: { goal: 'Write a greeting.\nFAKE: write note.txt first turn' },
    });
    name = agent.name;
    assert.equal(name, 'engineer-1');
    assert.equal(agent.worktree, join(directory, '仓库 with spaces.worktrees', name));
    const first = await call<WaitOutput>(client, 'wait', { agents: [name], timeout_s: 15 });
    assert.deepEqual(first.pending, []);
    assert.equal(first.finished.length, 1);
    const turn1 = first.finished[0]!;
    assert.equal(turn1.agent, name);
    assert.equal(turn1.turn, 1);
    assert.equal(turn1.result?.status, 'done');
    assert.equal(turn1.facts.error, undefined);
    assert.ok(turn1.facts.commit);
    assert.equal(await git(repo, 'show', `${turn1.facts.commit}:note.txt`), 'first turn');
    const sessions = readdirSync(env.FAKE_CODEX_HOME);
    assert.equal(sessions.length, 1);
    const session = sessions[0]!.replace(/\.json$/, '');
    assert.equal(turn1.result?.summary, `fake turn 1 of session ${session}`);

    assert.deepEqual(connection.errors, []);
    assert.equal(connection.stderr(), '');
    await client.close();
    connection = await connect(env, repo, []);
    client = connection.client;
    const continued = await call<AgentSummary[]>(client, 'list_agents');
    assert.equal(continued.length, 1);
    assert.equal(continued[0]!.name, name);
    assert.equal(continued[0]!.status, 'idle');
    assert.equal(continued[0]!.turns, 1);

    assert.deepEqual(await call<SendMessageOutput>(client, 'send_message', {
      to: name, text: 'Revise the greeting.\nFAKE: write note.txt second turn',
    }), { delivery: 'started' });
    const second = await call<WaitOutput>(client, 'wait', { agents: [name], timeout_s: 15 });
    assert.deepEqual(second.pending, []);
    assert.equal(second.finished.length, 1);
    const turn2 = second.finished[0]!;
    assert.equal(turn2.agent, name);
    assert.equal(turn2.turn, 2);
    assert.equal(turn2.result?.status, 'done');
    assert.equal(turn2.result?.summary, `fake turn 2 of session ${session}`);
    assert.equal(turn2.facts.error, undefined);
    assert.ok(turn2.facts.commit);
    assert.notEqual(turn2.facts.commit, turn1.facts.commit);
    assert.equal(await git(repo, 'show', `${turn2.facts.commit}:note.txt`), 'second turn');
    assert.deepEqual(readdirSync(env.FAKE_CODEX_HOME), sessions);
    assert.deepEqual(JSON.parse(readFileSync(join(env.FAKE_CODEX_HOME, sessions[0]!), 'utf8')), { turns: 2 });

    assert.deepEqual(await call(client, 'close_agent', { name, delete_branch: true }), { ok: true });
    assert.equal(existsSync(agent.worktree), false);
    assert.deepEqual(connection.errors, [], 'stdout must contain only valid MCP messages');
    assert.equal(connection.stderr(), '');
  } finally {
    await client.close();
  }

  // Omitting --repo also exercises the launch directory default.
  const reopened = await connect(env, repo, []);
  try {
    // Every agent of the latest run is closed, so the batch is over: a new, still-lazy run starts.
    assert.deepEqual(await call<AgentSummary[]>(reopened.client, 'list_agents'), []);
    assert.equal(readdirSync(env.SYNCW_RUNS_DIR).length, 1);
    assert.deepEqual(reopened.errors, []);
    assert.equal(reopened.stderr(), '');
  } finally {
    await reopened.client.close();
  }
});

test('--new-run ignores an open agent and stays lazy until spawning', { timeout: 45_000 }, async (t) => {
  const { directory, env } = fixture(t);
  const repo = await repository(directory);
  const first = await connect(env, repo, []);
  try {
    await call(first.client, 'spawn_agent', { role: 'engineer', task: { goal: 'Finish a turn.' } });
    await call(first.client, 'wait', { timeout_s: 15 });
  } finally {
    await first.client.close();
  }
  const original = onlyRun(env.SYNCW_RUNS_DIR);
  assert.equal(records(original)[0]!.status, 'idle');
  assertUnclaimed(original);
  const second = await connect(env, repo, ['--new-run']);
  try {
    assert.deepEqual(await call(second.client, 'list_agents'), []);
    assert.equal(onlyRun(env.SYNCW_RUNS_DIR), original);
    const agent = await call<SpawnAgentOutput>(second.client, 'spawn_agent', {
      role: 'engineer', task: { goal: 'Start a fresh run.' },
    });
    assert.notEqual(agent.name, records(original)[0]!.name);
    assert.equal(readdirSync(env.SYNCW_RUNS_DIR).length, 2);
    await call(second.client, 'wait', { timeout_s: 15 });
  } finally {
    await second.client.close();
  }
});

test('a live health check leaves the running agent and run untouched', { timeout: 45_000 }, async (t) => {
  const { directory, env } = fixture(t);
  const repo = await repository(directory);
  const first = await connect(env, repo, []);
  try {
    await call(first.client, 'spawn_agent', { role: 'engineer', task: { goal: 'Keep working.\nFAKE: sleep 6000' } });
    const runDir = onlyRun(env.SYNCW_RUNS_DIR);
    await until(() => records(runDir)[0]!.session_id !== undefined, 'fake turn did not start');
    const before = readFileSync(join(runDir, 'agents.json'), 'utf8');
    const claims = readdirSync(runDir).filter((name) => name.startsWith('owner-'));
    assert.equal(records(runDir)[0]!.status, 'running');
    const second = await connectDirect(env, repo);
    try {
      assert.deepEqual(await call(second.client, 'list_agents'), []);
      assert.equal(readFileSync(join(runDir, 'agents.json'), 'utf8'), before);
    } finally {
      await second.close();
    }
    assert.equal((await second.exited).code, 0, second.stderr());
    assert.equal(onlyRun(env.SYNCW_RUNS_DIR), runDir);
    assert.equal(readFileSync(join(runDir, 'agents.json'), 'utf8'), before);
    assert.deepEqual(readdirSync(runDir).filter((name) => name.startsWith('owner-')), claims);
    const completed = await call<WaitOutput>(first.client, 'wait', { timeout_s: 15 });
    assert.equal(completed.finished.length, 1);
    assert.equal(completed.finished[0]!.result?.status, 'done');
    assert.equal(completed.finished[0]!.facts.cancelled, false);
    assert.equal(completed.finished[0]!.facts.error, undefined);
    assert.equal(records(runDir)[0]!.status, 'idle');
  } finally {
    await first.client.close();
  }
});

test('stdin EOF cancels, commits and records a turn which the next server can resume', { timeout: 45_000 }, async (t) => {
  const { directory, env } = fixture(t);
  const repo = await repository(directory);
  const first = await connectDirect(env, repo);
  let runDir: string;
  let session: string;
  let name: string;
  try {
    const agent = await call<SpawnAgentOutput>(first.client, 'spawn_agent', {
      role: 'engineer', task: { goal: 'Save work before sleeping.\nFAKE: write saved.txt before shutdown\nFAKE: sleep 30000' },
    });
    name = agent.name;
    runDir = onlyRun(env.SYNCW_RUNS_DIR);
    await until(() => existsSync(join(agent.worktree, 'saved.txt')) && records(runDir)[0]!.session_id !== undefined,
      'fake turn did not write its file and publish its session');
    session = records(runDir)[0]!.session_id!;
    assert.equal(records(runDir)[0]!.status, 'running');
    // End stdin ourselves; there is no SDK client process-kill timer here.
    first.child.stdin.end();
    await until(() => first.child.exitCode !== null, 'EOF did not shut down the server within five seconds');
    assert.deepEqual(await first.exited, { code: 0, signal: null }, first.stderr());
    assert.equal(first.stderr(), '');
    const record = records(runDir)[0]!;
    assert.equal(record.status, 'interrupted');
    assert.equal(record.turns.length, 1);
    const turn = record.turns[0]!;
    assert.equal(turn.reported, false);
    assert.equal(turn.facts.cancelled, true);
    assert.match(turn.facts.error!, /post office shut down/);
    assert.ok(turn.facts.commit);
    assert.equal(await git(repo, 'show', `${turn.facts.commit}:saved.txt`), 'before shutdown');
    assertUnclaimed(runDir);
  } finally {
    await first.close();
  }
  const second = await connect(env, repo, []);
  try {
    const interrupted = await call<WaitOutput>(second.client, 'wait');
    assert.equal(interrupted.finished.length, 1);
    assert.equal(interrupted.finished[0]!.agent, name);
    assert.equal(interrupted.finished[0]!.turn, 1);
    assert.equal(interrupted.finished[0]!.facts.cancelled, true);
    assert.deepEqual(interrupted.pending, []);
    assert.deepEqual(await call(second.client, 'send_message', { to: name, text: 'Finish now.' }), { delivery: 'started' });
    const resumed = await call<WaitOutput>(second.client, 'wait', { timeout_s: 15 });
    assert.equal(resumed.finished.length, 1);
    assert.equal(resumed.finished[0]!.turn, 2);
    assert.equal(resumed.finished[0]!.result?.summary, `fake turn 2 of session ${session}`);
    assert.equal(resumed.finished[0]!.facts.error, undefined);
    assert.equal(onlyRun(env.SYNCW_RUNS_DIR), runDir);
    assert.deepEqual(readdirSync(env.FAKE_CODEX_HOME), [`${session}.json`]);
  } finally {
    await second.client.close();
  }
});

test('hard-killing the server kills both launcher layers and Codex', {
  timeout: 30_000, skip: process.platform !== 'win32' && 'POSIX Codex runs in a separate process group',
}, async (t) => {
  const { directory, env } = fixture(t);
  env.SYNCW_CODEX_COMMAND = JSON.stringify([process.execPath, join(root, 'test', 'fake-codex', 'launcher.ts')]);
  const repo = await repository(directory);
  const server = await connectDirect(env, repo);
  let pids: number[] = [];
  function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  }
  try {
    const agent = await call<SpawnAgentOutput>(server.client, 'spawn_agent', {
      role: 'engineer', task: { goal: 'Keep working.\nFAKE: sleep 30000' },
    });
    const runDir = onlyRun(env.SYNCW_RUNS_DIR);
    const stderrPath = join(runDir, agent.name, 'stderr.log');
    await until(() => {
      const lines = readFileSync(stderrPath, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length !== 2) return false;
      const layers = lines.map((line) => JSON.parse(line) as { launcher_pid: number; child_pid: number });
      pids = [...new Set(layers.flatMap((layer) => [layer.launcher_pid, layer.child_pid]))];
      return pids.length === 3 && records(runDir)[0]!.session_id !== undefined;
    }, 'both launchers and fake Codex did not start');
    assert.ok(pids.every(alive), `tree must be alive before killing the server: ${pids}`);
    assert.equal(records(runDir)[0]!.status, 'running');
    server.child.kill('SIGKILL');
    await server.exited;
    await until(() => pids.every((pid) => !alive(pid)), `Codex tree survived hard kill: ${pids.join(', ')}`);
  } finally {
    // Failure cleanup only, after the assertion: never make the survival check pass by killing descendants.
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    await server.close();
  }
});

test('starting and stopping without hiring leaves the runs directory absent', { timeout: 15_000 }, async (t) => {
  const { directory, env } = fixture(t);
  const repo = await repository(directory);
  const server = await connectDirect(env, repo);
  try {
    assert.deepEqual(await call(server.client, 'list_agents'), []);
    assert.equal(existsSync(env.SYNCW_RUNS_DIR), false);
  } finally {
    await server.close();
  }
  assert.deepEqual(await server.exited, { code: 0, signal: null }, server.stderr());
  assert.equal(existsSync(env.SYNCW_RUNS_DIR), false);
});

for (const failure of ['non-git repository', 'invalid limit', 'removed option'] as const) {
  test(`${failure} exits 1 with diagnostics only on stderr`, { timeout: 15_000 }, async (t) => {
    const { directory, env } = fixture(t);
    if (failure === 'invalid limit') env.SYNCW_MAX_AGENTS = '1.5';
    const result = await new Promise<{ code: string | number | undefined; stdout: string; stderr: string }>((done) => {
      execFile(process.execPath, [entry, '--repo', directory, ...(failure === 'removed option' ? ['--reopen'] : [])], {
        env, cwd: directory, windowsHide: true, timeout: 10_000,
      }, (error, stdout, stderr) => { done({ code: error?.code, stdout, stderr }); });
    });
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Syncw failed to start:/);
    assert.match(result.stderr, failure === 'invalid limit'
      ? /SYNCW_MAX_AGENTS must be a positive integer/
      : failure === 'removed option' ? /Unknown option '--reopen'/
        : /Cannot use repository.*Set --repo to a Git working tree/);
    assert.equal(existsSync(env.SYNCW_RUNS_DIR), false, 'failed startup must not create a run');
  });
}
