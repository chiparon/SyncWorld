import { execFile } from 'node:child_process';
import { readFileSync, realpathSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { accessSync } from 'node:fs';
import { constants } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createCodexEngine } from '../engines/codex.ts';
import type { PostOfficeLimits } from '../schema/types.ts';
import { createPostOffice } from './core.ts';
import { openRegistry } from './registry.ts';
import { createServer } from './server.ts';
import { createWorktrees } from './worktrees.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const execute = promisify(execFile);

/** Find the nearest .git directory by walking up from the given path. */
function findGitRoot(start: string): string | undefined {
  let current = resolve(start);
  const root = resolve('/');
  while (current !== root) {
    try {
      accessSync(join(current, '.git'), constants.F_OK);
      return current;
    } catch {
      current = resolve(current, '..');
    }
  }
  return undefined;
}

export function readOptions(args = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env) {
  const { values } = parseArgs({
    args,
    options: { repo: { type: 'string' }, 'new-run': { type: 'boolean' } },
    strict: true,
    allowPositionals: false,
  });
  const limits: Partial<PostOfficeLimits> = {};
  const variables = {
    max_parallel: 'SYNCW_MAX_PARALLEL',
    max_agents: 'SYNCW_MAX_AGENTS',
    max_turns: 'SYNCW_MAX_TURNS',
    turn_timeout_ms: 'SYNCW_TURN_TIMEOUT_MS',
  } as const;
  for (const key of Object.keys(variables) as (keyof PostOfficeLimits)[]) {
    const name = variables[key];
    const raw = env[name];
    if (raw === undefined) continue;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer; received ${JSON.stringify(raw)}.`);
    }
    limits[key] = value;
  }
  // Resolve repo: explicit --repo > walk up from cwd > fallback to Syncw root
  let repo: string;
  let explicitRepo = false;
  if (values.repo) {
    repo = resolve(values.repo);
    explicitRepo = true;
  } else {
    repo = findGitRoot(process.cwd()) ?? root;
  }
  return {
    repo,
    explicitRepo,
    runsDir: resolve(env.SYNCW_RUNS_DIR ?? join(root, 'runs')),
    mode: values['new-run'] ? 'new' as const : 'continue' as const,
    limits,
  };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = readOptions(args);
  // Defer repo validation: it will be checked when spawn_agent is called.
  // This allows MCP server to start even if cwd is not a git repository.
  // If --repo was explicit or repo was discovered, it will still be validated when used.
  const instructions = readFileSync(join(root, 'roles', 'scheduler.md'), 'utf8');
  const engine = createCodexEngine();
  const registry = openRegistry({ runsDir: options.runsDir, mode: options.mode, repo: options.repo });
  // Only validate repo when explicitly passed via --repo
  if (options.explicitRepo) {
    try {
      await execute('git', ['rev-parse', '--git-dir'], { cwd: options.repo });
    } catch {
      throw new Error(`Cannot use repository ${options.repo}. Set --repo to a Git working tree, or run from inside one.`);
    }
  }
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  let stop: (() => void) | undefined;
  try {
    const po = createPostOffice({
      registry,
      worktrees: createWorktrees(),
      engine,
      roles_dir: join(root, 'roles'),
      default_repo: options.repo,
      result_schema_path: join(root, 'src', 'schema', 'result.schema.json'),
      limits: options.limits,
    });
    let stopping = false;
    function exit(code: number, diagnostic?: string): never {
      try {
        registry.close();
      } finally {
        // A synchronous write preserves the diagnostic even when pipes are still open.
        try {
          if (diagnostic) writeSync(2, `${diagnostic.replace(/[\r\n]+/g, ' ')}\n`);
        } finally {
          process.exit(code);
        }
      }
    }
    stop = () => {
      if (stopping) return;
      stopping = true;
      // Keep this timer referenced: shutdown must finish or force the process to exit.
      const deadline = setTimeout(() => exit(1, 'Syncw shutdown timed out after 10 seconds; released the run claim.'), 10_000);
      void (async () => {
        try {
          await po.shutdown();
          clearTimeout(deadline);
          exit(0);
        } catch (error) {
          exit(1, `Syncw shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      })();
    };
    // The SDK transport listens for data, but does not handle the client's EOF.
    process.stdin.on('end', stop);
    for (const signal of signals) process.on(signal, stop);
    const server = createServer(po, { instructions });
    await server.connect(new StdioServerTransport());
    if (process.stdin.readableEnded) stop();
  } catch (error) {
    if (stop) {
      process.stdin.off('end', stop);
      for (const signal of signals) process.off(signal, stop);
    }
    registry.close();
    throw error;
  }
}

/**
 * `import.meta.main` is missing on older Node versions within our `engines`
 * range, and there it is undefined, which would make the server exit silently
 * without ever starting. Fall back to comparing paths, case-insensitively
 * because Windows may report the drive letter in either case.
 */
function isEntryPoint(): boolean {
  if (typeof import.meta.main === 'boolean') return import.meta.main;
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href.toLowerCase() === import.meta.url.toLowerCase();
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  try {
    await main();
  } catch (error) {
    console.error(`Syncw failed to start: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
