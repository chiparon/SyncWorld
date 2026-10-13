import { execFile } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createCodexEngine } from '../engines/codex.ts';
import type { PostOfficeLimits } from '../schema/types.ts';
import { createPostOffice } from './core.ts';
import { openRegistry } from './registry.ts';
import { createServer } from './server.ts';
import { createWorktrees } from './worktrees.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const execute = promisify(execFile);

export function readOptions(args = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env) {
  const { values } = parseArgs({
    args,
    options: { repo: { type: 'string' }, reopen: { type: 'boolean' } },
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
  return {
    repo: resolve(values.repo ?? process.cwd()),
    runsDir: resolve(env.SYNCW_RUNS_DIR ?? join(root, 'runs')),
    reopenLatest: values.reopen ?? false,
    limits,
  };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = readOptions(args);
  // Reject configuration errors before creating a run or accepting MCP requests.
  try {
    await execute('git', ['-C', options.repo, 'rev-parse', '--show-toplevel'], { windowsHide: true });
  } catch (error) {
    throw new Error(
      `Cannot use repository "${options.repo}". Set --repo to a Git working tree and ensure Git is installed. `
        + (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  }
  const instructions = readFileSync(join(root, 'roles', 'scheduler.md'), 'utf8');
  const engine = createCodexEngine();
  const registry = openRegistry({ runsDir: options.runsDir, reopenLatest: options.reopenLatest });
  const po = createPostOffice({
    registry,
    worktrees: createWorktrees(),
    engine,
    roles_dir: join(root, 'roles'),
    default_repo: options.repo,
    result_schema_path: join(root, 'src', 'schema', 'result.schema.json'),
    limits: options.limits,
  });
  const server = createServer(po, { instructions });
  await server.connect(new StdioServerTransport());
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
