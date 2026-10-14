import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createCodexEngine } from '../../src/engines/codex.ts';
import { createPostOffice } from '../../src/postoffice/core.ts';
import { openRegistry } from '../../src/postoffice/registry.ts';
import { createWorktrees } from '../../src/postoffice/worktrees.ts';
import type { Engine, PostOffice, Registry, RunningTurn, TurnReport } from '../../src/schema/types.ts';

const execute = promisify(execFile);
const fake = fileURLToPath(new URL('../fake-codex/codex.ts', import.meta.url));
const schema = fileURLToPath(new URL('../../src/schema/result.schema.json', import.meta.url));

async function git(repo: string, ...args: string[]): Promise<string> {
  return (await execute('git', ['-c', 'core.quotepath=false', '-C', repo, ...args], {
    encoding: 'utf8', windowsHide: true,
  })).stdout.trim();
}

async function drain(office: PostOffice): Promise<TurnReport[]> {
  const reports: TurnReport[] = [];
  for (;;) {
    const output = await office.wait({ timeout_s: 15 });
    reports.push(...output.finished);
    if (!output.pending.length) return reports;
    assert.ok(output.finished.length, 'agents must finish within the test timeout');
  }
}

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'syncw-names-'));
  const repo = join(root, 'repo with spaces');
  const roles = join(root, 'roles');
  const runsDir = join(root, 'runs');
  const offices: { office: PostOffice; registry: Registry; started: RunningTurn[] }[] = [];
  t.after(async () => {
    for (const { office, registry, started } of offices) {
      for (const record of registry.list()) {
        if (record.status === 'queued' || record.status === 'running') await office.cancelAgent(record.name);
      }
      await Promise.all(started.map((turn) => turn.done));
      await drain(office);
      registry.close();
    }
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(repo);
  mkdirSync(roles);
  writeFileSync(join(roles, 'engineer.md'), 'Implement carefully.');
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

  function newOffice() {
    const registry = openRegistry({ runsDir, mode: 'new' });
    const started: RunningTurn[] = [];
    const codex = createCodexEngine({
      command: [process.execPath, fake],
      env: { ...process.env, FAKE_CODEX_HOME: join(root, 'sessions') },
    });
    const engine: Engine = {
      kind: codex.kind,
      startTurn(request) {
        const turn = codex.startTurn(request);
        started.push(turn);
        return turn;
      },
    };
    const office = createPostOffice({
      registry, worktrees: createWorktrees(), engine,
      roles_dir: roles, default_repo: repo, result_schema_path: schema,
    });
    offices.push({ office, registry, started });
    return { office, registry };
  }
  return { repo, newOffice };
}

test('spawn_agent skips leftover branches and directories across new runs', async (t) => {
  const { repo, newOffice } = await fixture(t);
  await git(repo, 'branch', 'syncw/engineer-1');
  mkdirSync(join(`${repo}.worktrees`, 'engineer-2'), { recursive: true });
  const firstRun = newOffice();
  const input = { role: 'engineer', task: { goal: 'Finish.' } };

  const first = await firstRun.office.spawnAgent(input);
  assert.equal(first.name, 'engineer-3');
  const second = await firstRun.office.spawnAgent(input);
  assert.equal(second.name, 'engineer-4');
  const reports = await drain(firstRun.office);
  assert.equal(reports.length, 2);
  for (const report of reports) {
    assert.equal(report.result?.status, 'done');
    assert.equal(report.facts.exit_code, 0);
    assert.equal(report.facts.error, undefined);
  }

  await firstRun.office.closeAgent(first.name);
  assert.equal(existsSync(first.worktree), false);
  assert.equal(await git(repo, 'for-each-ref', '--format=%(refname)', `refs/heads/${first.branch}`), 'refs/heads/syncw/engineer-3');
  assert.ok(existsSync(second.worktree));

  const secondRun = newOffice();
  assert.notEqual(secondRun.registry.runId, firstRun.registry.runId);
  assert.deepEqual(secondRun.registry.list(), []);
  const next = await secondRun.office.spawnAgent(input);
  assert.equal(next.name, 'engineer-5');
  const [report] = await drain(secondRun.office);
  assert.equal(report!.result?.status, 'done');
  assert.equal(report!.facts.exit_code, 0);
  assert.equal(report!.facts.error, undefined);
});
