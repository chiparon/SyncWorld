import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

import { readOptions } from '../../src/postoffice/main.ts';
import type { AgentSummary, SendMessageOutput, SpawnAgentOutput, WaitOutput } from '../../src/schema/types.ts';

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
    reopenLatest: false,
    limits: {},
  });
});

test('options resolve CLI paths, reopen, and all four environment limits', () => {
  assert.deepEqual(readOptions(['--repo', 'relative repo', '--reopen'], {
    SYNCW_RUNS_DIR: 'relative runs',
    SYNCW_MAX_PARALLEL: '2',
    SYNCW_MAX_AGENTS: '3',
    SYNCW_MAX_TURNS: '4',
    SYNCW_TURN_TIMEOUT_MS: '5000',
  }), {
    repo: resolve('relative repo'),
    runsDir: resolve('relative runs'),
    reopenLatest: true,
    limits: { max_parallel: 2, max_agents: 3, max_turns: 4, turn_timeout_ms: 5000 },
  });
  assert.throws(() => readOptions(['--repo'], {}), /--repo/);
  assert.throws(() => readOptions(['--unknown'], {}), /--unknown/);
  assert.throws(() => readOptions(['unexpected'], {}), /unexpected/);
});

test('every configured limit must be a positive decimal safe integer', () => {
  for (const name of ['SYNCW_MAX_PARALLEL', 'SYNCW_MAX_AGENTS', 'SYNCW_MAX_TURNS', 'SYNCW_TURN_TIMEOUT_MS']) {
    for (const value of ['', '0', '-1', '1.5', 'NaN', 'Infinity', '1e3', '9007199254740992']) {
      assert.throws(() => readOptions([], { [name]: value }), new RegExp(`${name} must be a positive integer`));
    }
  }
});

test('stdio server runs, commits, resumes, closes an agent, and reopens its registry', { timeout: 45_000 }, async (t) => {
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
  const connection = await connect(env, directory, ['--repo', repo]);
  const { client } = connection;
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
  const reopened = await connect(env, repo, ['--reopen']);
  try {
    const agents = await call<AgentSummary[]>(reopened.client, 'list_agents');
    assert.equal(agents.length, 1);
    assert.equal(agents[0]?.name, name);
    assert.equal(agents[0]?.status, 'closed');
    assert.equal(agents[0]?.turns, 2);
    assert.equal(readdirSync(env.SYNCW_RUNS_DIR).length, 1);
    assert.deepEqual(reopened.errors, []);
    assert.equal(reopened.stderr(), '');
  } finally {
    await reopened.client.close();
  }
});

for (const failure of ['non-git repository', 'invalid limit'] as const) {
  test(`${failure} exits 1 with diagnostics only on stderr`, { timeout: 15_000 }, async (t) => {
    const { directory, env } = fixture(t);
    if (failure === 'invalid limit') env.SYNCW_MAX_AGENTS = '1.5';
    const result = await new Promise<{ code: string | number | undefined; stdout: string; stderr: string }>((done) => {
      execFile(process.execPath, [entry, '--repo', directory], {
        env, cwd: directory, windowsHide: true, timeout: 10_000,
      }, (error, stdout, stderr) => { done({ code: error?.code, stdout, stderr }); });
    });
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Syncw failed to start:/);
    assert.match(result.stderr, failure === 'invalid limit'
      ? /SYNCW_MAX_AGENTS must be a positive integer/
      : /Cannot use repository.*Set --repo to a Git working tree/);
    assert.equal(existsSync(env.SYNCW_RUNS_DIR), false, 'failed startup must not create a run');
  });
}
