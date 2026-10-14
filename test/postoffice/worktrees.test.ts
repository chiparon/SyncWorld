import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { promisify } from 'node:util';

import { createWorktrees } from '../../src/postoffice/worktrees.ts';

const execute = promisify(execFile);
const author = { name: 'Worker "Two" Agent', email: 'engineer-2@example.test' };

async function git(repo: string, ...args: string[]): Promise<string> {
  const result = await execute('git', ['-c', 'core.quotepath=false', '-C', repo, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.stdout.trim();
}

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'syncw-worktrees-'));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  // Exercise argument handling with both spaces and non-ASCII characters in repository paths.
  const repo = join(root, '仓库 with spaces');
  mkdirSync(repo);
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
  return { root, repo, hooks, base, worktrees: createWorktrees() };
}

test('create resolves the repo top level, path, branch, and default base sha', async (t) => {
  const { root, repo, base, worktrees } = await fixture(t);
  const nested = join(repo, 'nested directory');
  mkdirSync(nested);
  const created = await worktrees.create(nested, 'engineer-1');

  assert.deepEqual(created, {
    branch: 'syncw/engineer-1',
    worktree: join(root, '仓库 with spaces.worktrees', 'engineer-1'),
    base,
  });
  assert.ok(isAbsolute(created.worktree));
  assert.equal(await git(created.worktree, 'symbolic-ref', '--short', 'HEAD'), created.branch);
  assert.equal(await git(created.worktree, 'rev-parse', 'HEAD'), base);
  assert.equal(readFileSync(join(created.worktree, 'initial.txt'), 'utf8'), 'initial\n');
});

test('create resolves an explicit commit-ish instead of using HEAD', async (t) => {
  const { repo, base, worktrees } = await fixture(t);
  writeFileSync(join(repo, 'later.txt'), 'later\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-m', 'Later commit');

  const created = await worktrees.create(repo, 'engineer-1', 'HEAD~1');
  assert.equal(created.base, base);
  assert.equal(await git(created.worktree, 'rev-parse', 'HEAD'), base);
  assert.equal(existsSync(join(created.worktree, 'later.txt')), false);
});

test('usedNames returns local syncw branches only', async (t) => {
  const { repo, base, worktrees } = await fixture(t);
  await git(repo, 'branch', 'syncw/engineer-1');
  await git(repo, 'branch', 'syncw/researcher-1');
  await git(repo, 'branch', 'other/engineer-2');
  await git(repo, 'branch', 'syncw-other/engineer-3');
  await git(repo, 'tag', 'syncw/engineer-4');
  await git(repo, 'update-ref', 'refs/remotes/origin/syncw/engineer-5', base);

  assert.deepEqual(await worktrees.usedNames(repo), new Set(['engineer-1', 'researcher-1']));
});

test('usedNames preserves the entire nested branch name after syncw/', async (t) => {
  const { repo, worktrees } = await fixture(t);
  await git(repo, 'branch', 'syncw/a/b');
  await git(repo, 'branch', 'syncw/a/c/d');

  assert.deepEqual(await worktrees.usedNames(repo), new Set(['a/b', 'a/c/d']));
});

test('usedNames returns entries including unregistered directories and plain files', async (t) => {
  const { repo, worktrees } = await fixture(t);
  const directory = `${repo}.worktrees`;
  mkdirSync(join(directory, 'stray', 'nested'), { recursive: true });
  writeFileSync(join(directory, 'plain-file'), 'occupied');
  await git(repo, 'worktree', 'add', '--detach', join(directory, 'registered'), 'HEAD');

  assert.deepEqual(await worktrees.usedNames(repo), new Set(['stray', 'plain-file', 'registered']));
});

test('usedNames combines branches and entries without duplicates', async (t) => {
  const { repo, worktrees } = await fixture(t);
  await worktrees.create(repo, 'engineer-1');
  await git(repo, 'branch', 'syncw/engineer-2');
  mkdirSync(join(`${repo}.worktrees`, 'engineer-3'));

  assert.deepEqual(await worktrees.usedNames(repo), new Set(['engineer-1', 'engineer-2', 'engineer-3']));
});

test('usedNames returns an empty set when no branches or worktrees directory exist', async (t) => {
  const { repo, worktrees } = await fixture(t);
  assert.equal(existsSync(`${repo}.worktrees`), false);
  assert.deepEqual(await worktrees.usedNames(repo), new Set());
});

test('usedNames returns an empty set for an empty worktrees directory', async (t) => {
  const { repo, worktrees } = await fixture(t);
  mkdirSync(`${repo}.worktrees`);
  assert.deepEqual(await worktrees.usedNames(repo), new Set());
});

test('usedNames resolves a repository subdirectory to its top level', async (t) => {
  const { repo, worktrees } = await fixture(t);
  const nested = join(repo, 'nested directory');
  mkdirSync(nested);
  await git(repo, 'branch', 'syncw/engineer-1');
  mkdirSync(join(`${repo}.worktrees`, 'engineer-2'), { recursive: true });

  assert.deepEqual(await worktrees.usedNames(nested), new Set(['engineer-1', 'engineer-2']));
});

test('usedNames rejects non-repositories with the failing git command', async (t) => {
  const { root, worktrees } = await fixture(t);
  await assert.rejects(worktrees.usedNames(root), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Git command failed:.*git.*core\.quotepath=false.*rev-parse.*--show-toplevel/);
    assert.match(error.message, /fatal:/);
    return true;
  });
});

test('create rejects existing worktrees and paths without overwriting them', async (t) => {
  const { root, repo, worktrees } = await fixture(t);
  const created = await worktrees.create(repo, 'engineer-1');
  await assert.rejects(worktrees.create(repo, 'engineer-1'), /Worktree path.*engineer-1.*already exists/);
  assert.equal(await git(created.worktree, 'symbolic-ref', '--short', 'HEAD'), created.branch);

  const occupied = join(root, '仓库 with spaces.worktrees', 'engineer-2');
  writeFileSync(occupied, 'keep this file');
  await assert.rejects(worktrees.create(repo, 'engineer-2'), /Worktree path.*engineer-2.*already exists/);
  assert.equal(readFileSync(occupied, 'utf8'), 'keep this file');
});

test('create rejects an existing branch even when its worktree path is free', async (t) => {
  const { repo, base, worktrees } = await fixture(t);
  await git(repo, 'branch', 'syncw/engineer-1');
  await assert.rejects(worktrees.create(repo, 'engineer-1'), /Branch "syncw\/engineer-1" already exists/);
  assert.equal(await git(repo, 'rev-parse', 'syncw/engineer-1'), base);
});

test('git failures include the command and stderr for invalid repositories and bases', async (t) => {
  const { root, repo, worktrees } = await fixture(t);
  await assert.rejects(worktrees.create(root, 'engineer-1'), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Git command failed:.*git.*core\.quotepath=false.*rev-parse.*--show-toplevel/);
    assert.match(error.message, /fatal:/);
    return true;
  });
  await assert.rejects(worktrees.create(repo, 'engineer-1', 'missing-base'), /rev-parse.*--verify.*missing-base/);
});

test('commitAll stages all changes, uses the supplied author, and returns the sha and trimmed stat', async (t) => {
  const { repo, worktrees } = await fixture(t);
  const created = await worktrees.create(repo, 'engineer-1');
  writeFileSync(join(created.worktree, 'new file.txt'), 'new content\n');
  rmSync(join(created.worktree, 'initial.txt'));
  const message = 'Worker "Two": quotes, $variables, & spaces\n\nDetails.';
  const committed = await worktrees.commitAll(created.worktree, message, author);

  assert.ok(committed);
  assert.match(committed.commit, /^[a-f0-9]{40,64}$/);
  assert.equal(committed.commit, await git(created.worktree, 'rev-parse', 'HEAD'));
  assert.equal(await git(created.worktree, 'show', '-s', '--format=%an%n%ae', committed.commit), `${author.name}\n${author.email}`);
  assert.equal(await git(created.worktree, 'show', '-s', '--format=%B', committed.commit), message);
  assert.match(committed.diff_stat, /new file\.txt/);
  assert.match(committed.diff_stat, /initial\.txt/);
  assert.equal(committed.diff_stat, await git(created.worktree, 'show', '--stat', '--format=', committed.commit));
  assert.equal(await git(created.worktree, 'status', '--porcelain'), '');
  assert.equal(await git(repo, 'config', '--local', 'user.name'), 'Original Author');
  assert.equal(await git(repo, 'config', '--local', 'user.email'), 'original@example.test');
});

test('commitAll returns undefined without creating a commit when nothing changed', async (t) => {
  const { repo, base, worktrees } = await fixture(t);
  const created = await worktrees.create(repo, 'engineer-1');
  assert.equal(await worktrees.commitAll(created.worktree, 'Nothing changed', author), undefined);
  assert.equal(await git(created.worktree, 'rev-parse', 'HEAD'), base);
});

test('commitAll preserves non-ASCII filenames in its diff stat', async (t) => {
  const { repo, worktrees } = await fixture(t);
  const created = await worktrees.create(repo, 'engineer-1');
  const filename = '你好.txt';
  writeFileSync(join(created.worktree, filename), 'Non-ASCII filename\n');
  const committed = await worktrees.commitAll(created.worktree, 'Add Unicode filename', author);
  assert.ok(committed);
  assert.ok(committed.diff_stat.includes(filename));
  assert.equal(await git(created.worktree, 'show', `${committed.commit}:${filename}`), 'Non-ASCII filename');
});

test('commitAll honors rejecting hooks and reports their stderr', async (t) => {
  const { repo, hooks, base, worktrees } = await fixture(t);
  const created = await worktrees.create(repo, 'engineer-1');
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nprintf "blocked by test hook\\n" >&2\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(created.worktree, 'rejected.txt'), 'pending\n');

  await assert.rejects(worktrees.commitAll(created.worktree, 'Rejected commit', author), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Git command failed:.*commit.*Rejected commit/);
    assert.match(error.message, /blocked by test hook/);
    return true;
  });
  assert.equal(await git(created.worktree, 'rev-parse', 'HEAD'), base);
  assert.equal(await git(created.worktree, 'diff', '--cached', '--name-only'), 'rejected.txt');
});

test('remove force-removes a dirty worktree but keeps its branch by default, including on retry', async (t) => {
  const { repo, base, worktrees } = await fixture(t);
  const created = await worktrees.create(repo, 'engineer-1');
  writeFileSync(join(created.worktree, 'uncommitted.txt'), 'uncommitted\n');
  await worktrees.remove(repo, created.worktree);
  assert.equal(existsSync(created.worktree), false);
  assert.equal(await git(repo, 'rev-parse', created.branch), base);
  await assert.doesNotReject(worktrees.remove(repo, created.worktree));
});

test('remove optionally deletes the branch and tolerates repeated cleanup', async (t) => {
  const { repo, worktrees } = await fixture(t);
  const created = await worktrees.create(repo, 'engineer-1');
  const options = { deleteBranch: created.branch };
  await worktrees.remove(repo, created.worktree, options);
  assert.equal(existsSync(created.worktree), false);
  assert.equal(await git(repo, 'for-each-ref', '--format=%(refname)', `refs/heads/${created.branch}`), '');
  await assert.doesNotReject(worktrees.remove(repo, created.worktree, options));
});

test('remove handles a worktree directory already removed outside git', async (t) => {
  const { root, repo, worktrees } = await fixture(t);
  const created = await worktrees.create(repo, 'engineer-1');
  assert.equal(dirname(dirname(resolve(created.worktree))), resolve(root));
  rmSync(created.worktree, { recursive: true, force: true });
  await assert.doesNotReject(worktrees.remove(repo, created.worktree, { deleteBranch: created.branch }));
  const entries = (await git(repo, 'worktree', 'list', '--porcelain', '-z')).split('\0');
  assert.equal(entries.filter((entry) => entry.startsWith('worktree ')).length, 1);
});

test('remove reports real failures for an existing worktree and a branch still in use', async (t) => {
  const { repo, worktrees } = await fixture(t);
  const first = await worktrees.create(repo, 'engineer-1');
  const second = await worktrees.create(repo, 'engineer-2');
  await git(repo, 'worktree', 'lock', first.worktree);
  await assert.rejects(worktrees.remove(repo, first.worktree), /Git command failed:.*worktree.*remove/);
  await git(repo, 'worktree', 'unlock', first.worktree);
  await assert.rejects(worktrees.remove(repo, first.worktree, { deleteBranch: second.branch }), /Git command failed:.*branch.*-D/);
  assert.ok(existsSync(second.worktree));
});
