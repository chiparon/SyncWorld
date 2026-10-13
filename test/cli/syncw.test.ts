import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { readOptions } from '../../src/cli/syncw.ts';
import type { AgentRecord } from '../../src/schema/types.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const entry = join(root, 'src', 'cli', 'syncw.ts');

function fixture(t: TestContext, populated = true) {
  const directory = mkdtempSync(join(tmpdir(), 'syncw-cli-'));
  t.after(() => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  });
  const runsDir = join(directory, 'runs');
  const runId = '20261014-120000-test';
  const runDir = join(runsDir, runId);
  const agents: AgentRecord[] = ['engineer-1', 'reviewer-1'].map((name) => ({
    name, role: name.split('-')[0]!, brief: '', task: { goal: `Task for ${name}` },
    engine: 'codex', hired_by: 'scheduler', repo: directory, base: 'abc',
    branch: `syncw/${name}`, worktree: join(directory, name),
    status: 'idle', turns: [], queued_messages: [], created_at: '2026-10-14T12:00:00Z',
  }));
  if (populated) {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'agents.json'), JSON.stringify(agents));
    mkdirSync(join(runsDir, '20261014-130000-empty'));
    writeFileSync(join(runsDir, '20261014-130000-empty', 'agents.json'), '[]');
  }
  function invoke(args: string[]) {
    const result = spawnSync(process.execPath, [entry, ...args], {
      env: { ...process.env, SYNCW_RUNS_DIR: runsDir }, cwd: directory,
      encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    return result;
  }
  return { runsDir, runId, runDir, agents, invoke };
}

test('default runs directory is relative to the module; environment paths are resolved', () => {
  assert.equal(readOptions(['status'], {}).runsDir, join(root, 'runs'));
  assert.equal(readOptions(['status'], { SYNCW_RUNS_DIR: 'relative runs' }).runsDir, resolve('relative runs'));
});

test('JSON status matches the fixture and uses two-space indentation', (t) => {
  const { runId, runDir, agents, invoke } = fixture(t);
  const result = invoke(['status', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const expected = {
    run_id: runId, run_dir: runDir,
    agents: agents.map((agent) => ({
      name: agent.name, role: agent.role, status: agent.status, branch: agent.branch,
      goal: agent.task.goal, turns: 0, queued_messages: 0,
    })),
  };
  assert.deepEqual(JSON.parse(result.stdout), expected);
  assert.equal(result.stdout, `${JSON.stringify(expected, null, 2)}\n`);
});

test('text status exits zero and mentions every agent', (t) => {
  const { agents, invoke } = fixture(t);
  const result = invoke(['status']);
  assert.equal(result.status, 0);
  for (const agent of agents) assert.ok(result.stdout.includes(agent.name));
});

test('--run can select an empty run', (t) => {
  const { invoke } = fixture(t);
  const result = invoke(['status', '--run', '20261014-130000-empty', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).agents, []);
  assert.equal(JSON.parse(result.stdout).run_id, '20261014-130000-empty');
});

test('--run rejects relative traversal and absolute paths to a valid sibling run', (t) => {
  const { runsDir, agents, invoke } = fixture(t);
  const sibling = join(dirname(runsDir), 'outside');
  mkdirSync(sibling);
  writeFileSync(join(sibling, 'agents.json'), JSON.stringify(agents));
  for (const runId of ['../outside', '..\\outside', sibling]) {
    const result = invoke(['status', '--run', runId, '--json']);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Unknown run.*Choose an existing run id/);
  }
});

test('no runs exits one with one actionable message on stderr', (t) => {
  const { runsDir, invoke } = fixture(t, false);
  const result = invoke(['status']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.includes(runsDir));
  assert.match(result.stderr, /No run with agents.*Start a Syncw run/);
  assert.equal(result.stderr.trim().split('\n').length, 1);
});

test('unknown options, subcommands, run ids and missing option values fail without stack traces', (t) => {
  const { invoke } = fixture(t);
  for (const args of [['status', '--unknown'], ['unknown'], ['status', 'extra'], ['status', '--run'], ['status', '--run', 'missing']]) {
    const result = invoke(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /--help|Choose an existing run id/);
    assert.equal(result.stderr.trim().split('\n').length, 1);
    assert.doesNotMatch(result.stderr, /\bat .*\.ts:/);
    assert.doesNotMatch(result.stderr, /\.\. Run syncw --help/);
  }
});

test('help goes to stdout; no subcommand sends usage to stderr and exits one', (t) => {
  const { invoke } = fixture(t, false);
  for (const args of [['--help'], ['status', '--help']]) {
    const result = invoke(args);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: syncw status/);
    assert.equal(result.stderr, '');
  }
  const result = invoke([]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Usage: syncw status/);
});
