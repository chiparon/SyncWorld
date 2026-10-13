import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { formatRunStatus } from '../status/format.ts';
import { readRunStatus } from '../status/read.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const usage = `Usage: syncw status [--run <run-id>] [--json]
       syncw --help

Show the latest run with agents, or select a run with --run.
Set SYNCW_RUNS_DIR to override the default runs directory.
`;

export function readOptions(args = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        run: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message.replace(/\.$/, '')}. Run syncw --help for usage.`);
  }
  const { values, positionals } = parsed;
  if (positionals.length > 1 || (positionals.length === 1 && positionals[0] !== 'status')) {
    throw new Error(`Unknown subcommand or argument ${JSON.stringify(positionals.find((value, index) => index > 0 || value !== 'status'))}. Run syncw --help for usage.`);
  }
  return {
    help: values.help ?? false,
    command: positionals[0],
    json: values.json ?? false,
    runId: values.run,
    runsDir: resolve(env.SYNCW_RUNS_DIR ?? join(root, 'runs')),
  };
}

export function main(args = process.argv.slice(2)): number {
  try {
    const opts = readOptions(args);
    if (opts.help) {
      process.stdout.write(usage);
      return 0;
    }
    if (!opts.command) {
      process.stderr.write(usage);
      return 1;
    }
    const status = readRunStatus(opts);
    const output = opts.json
      ? JSON.stringify(status, null, 2)
      : formatRunStatus(status, process.stdout.isTTY ? { width: process.stdout.columns } : {});
    process.stdout.write(`${output}\n`);
    return 0;
  } catch (error) {
    // Keep CLI failures readable even when an underlying message spans lines.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message.replace(/[\r\n]+/g, ' ')}\n`);
    return 1;
  }
}

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

if (isEntryPoint()) process.exitCode = main();
