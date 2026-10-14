import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import type { Worktrees } from '../schema/types.ts';

export function createWorktrees(opts: { git?: string } = {}): Worktrees {
  const executable = opts.git ?? 'git';

  function git(args: string[], allowedExitCodes = [0]): Promise<{ stdout: string; code: number }> {
    const command = ['-c', 'core.quotepath=false', ...args];
    return new Promise((resolveCommand, reject) => {
      execFile(executable, command, { encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
        const code = error ? error.code : 0;
        if (typeof code !== 'number' || !allowedExitCodes.includes(code)) {
          const display = [executable, ...command].map((arg) => JSON.stringify(arg)).join(' ');
          reject(new Error(`Git command failed: ${display}\n${stderr.trim() || error?.message}`, {
            cause: error,
          }));
          return;
        }
        resolveCommand({ stdout, code });
      });
    });
  }

  async function branchExists(repo: string, branch: string): Promise<boolean> {
    const result = await git(['-C', repo, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], [0, 1]);
    return result.code === 0;
  }

  return {
    async create(repo, name, base = 'HEAD') {
      const top = resolve((await git(['-C', repo, 'rev-parse', '--show-toplevel'])).stdout.trim());
      const sha = (await git(['-C', top, 'rev-parse', '--verify', `${base}^{commit}`])).stdout.trim();
      const worktree = join(dirname(top), `${basename(top)}.worktrees`, name);
      const branch = `syncw/${name}`;

      if (existsSync(worktree)) {
        throw new Error(`Worktree path "${worktree}" already exists. Choose another agent name or remove it first.`);
      }
      if (await branchExists(top, branch)) {
        throw new Error(`Branch "${branch}" already exists. Choose another agent name or delete that branch first.`);
      }

      await git(['-C', top, 'worktree', 'add', '-b', branch, worktree, sha]);
      return { branch, worktree, base: sha };
    },
    async commitAll(worktree, message, author) {
      await git(['-C', worktree, 'add', '-A']);
      const diff = await git(['-C', worktree, 'diff', '--cached', '--quiet'], [0, 1]);
      if (diff.code === 0) return undefined;

      await git([
        '-C', worktree,
        '-c', `user.name=${author.name}`,
        '-c', `user.email=${author.email}`,
        'commit', '-m', message,
      ]);
      const commit = (await git(['-C', worktree, 'rev-parse', 'HEAD'])).stdout.trim();
      const diff_stat = (await git(['-C', worktree, 'show', '--stat', '--format=', commit])).stdout.trim();
      return { commit, diff_stat };
    },
    async remove(repo, worktree, options) {
      try {
        await git(['-C', repo, 'worktree', 'remove', '--force', worktree]);
      } catch (error) {
        // Check filesystem state, not localized git diagnostics, for an already-removed worktree.
        if (existsSync(resolve(repo, worktree))) throw error;
        await git(['-C', repo, 'worktree', 'prune']);
      }

      if (options?.deleteBranch) {
        try {
          await git(['-C', repo, 'branch', '-D', options.deleteBranch]);
        } catch (error) {
          if (await branchExists(repo, options.deleteBranch)) throw error;
        }
      }
    },
    async usedNames(repo) {
      const top = resolve((await git(['-C', repo, 'rev-parse', '--show-toplevel'])).stdout.trim());
      const prefix = 'refs/heads/syncw/';
      const branches = await git(['-C', top, 'for-each-ref', '--format=%(refname)', prefix]);
      const names = new Set(branches.stdout.split(/\r?\n/)
        .filter((ref) => ref.startsWith(prefix))
        .map((ref) => ref.slice(prefix.length)));

      // Unregistered directories and plain files block create just as worktrees do.
      try {
        for (const name of readdirSync(join(dirname(top), `${basename(top)}.worktrees`))) {
          names.add(name);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return names;
    },
  };
}
