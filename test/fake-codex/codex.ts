import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { ResultStatus, WorkerResult } from '../../src/schema/types.ts';

function emit(event: object): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function main(): Promise<number> {
  const home = process.env.FAKE_CODEX_HOME;
  if (!home) {
    process.stderr.write('FAKE_CODEX_HOME is required; set it to a directory for fake session files.\n');
    return 2;
  }
  const args = process.argv.slice(2);
  if (args.shift() !== 'exec') throw new Error('Expected exec [resume <session-id>] [flags] -.');
  let sessionId: string | undefined;
  if (args[0] === 'resume') {
    args.shift();
    sessionId = args.shift();
    if (!sessionId) throw new Error('resume requires a session id.');
  }
  let output: string | undefined;
  let cwd = process.cwd();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' || arg === '-') continue;
    if (arg === '-o' || arg === '-C' || arg === '-s' || arg === '-c' || arg === '--output-schema' || arg === '-m') {
      const value = args[++i];
      if (value === undefined) throw new Error(`${arg} requires a value.`);
      if (arg === '-o') output = value;
      if (arg === '-C') cwd = path.resolve(value);
    } else {
      throw new Error(`Unknown fake Codex argument: ${arg}.`);
    }
  }
  if (args.at(-1) !== '-') throw new Error('Expected a trailing - to read the prompt from stdin.');
  if (!output) throw new Error('-o <file> is required.');
  process.stdin.setEncoding('utf8');
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk;

  await mkdir(home, { recursive: true });
  let turns = 0;
  if (sessionId !== undefined) {
    try {
      const saved = JSON.parse(await readFile(path.join(home, `${sessionId}.json`), 'utf8')) as { turns: number };
      turns = saved.turns;
    } catch {
      emit({ type: 'error', message: `Unknown fake Codex session: ${sessionId}` });
      return 1;
    }
  } else {
    sessionId = randomUUID();
  }
  turns++;
  await writeFile(path.join(home, `${sessionId}.json`), JSON.stringify({ turns }));
  emit({ type: 'thread.started', thread_id: sessionId });
  emit({ type: 'turn.started' });

  const written: string[] = [];
  const details: string[] = [];
  let status: ResultStatus = 'done';
  let badResult = false;
  let noResult = false;
  let failure: string | undefined;
  let exitCode = 0;
  for (const line of prompt.split(/\r?\n/)) {
    if (!line.startsWith('FAKE:')) {
      details.push(line);
      continue;
    }
    const directive = line.slice('FAKE:'.length).trim();
    const write = /^write\s+(\S+)(?:\s(.*))?$/.exec(directive);
    if (write) {
      const filename = write[1]!;
      const absolute = path.resolve(cwd, filename);
      const kind = existsSync(absolute) ? 'update' : 'add';
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, write[2] ?? '');
      written.push(filename);
      emit({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: absolute, kind }] } });
    } else if (directive.startsWith('sleep ')) {
      await sleep(Number(directive.slice('sleep '.length)));
    } else if (directive.startsWith('status ')) {
      const value = directive.slice('status '.length);
      if (value !== 'done' && value !== 'failed' && value !== 'blocked') throw new Error(`Invalid fake status: ${value}.`);
      status = value;
    } else if (directive === 'bad-result') {
      badResult = true;
    } else if (directive === 'no-result') {
      noResult = true;
    } else if (directive.startsWith('fail-turn ')) {
      failure = directive.slice('fail-turn '.length);
    } else if (directive.startsWith('exit ')) {
      exitCode = Number(directive.slice('exit '.length));
    } else {
      throw new Error(`Unknown fake Codex directive: ${directive}.`);
    }
  }

  if (failure !== undefined) {
    emit({ type: 'turn.failed', error: { message: failure } });
    return 1;
  }
  if (!noResult) {
    const result: WorkerResult = {
      status,
      summary: `fake turn ${turns} of session ${sessionId}`,
      details: details.join('\n').trim(),
      files_changed: written,
      open_questions: [],
    };
    await writeFile(path.resolve(cwd, output), badResult ? '{invalid JSON' : JSON.stringify(result));
  }
  emit({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } });
  return exitCode;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
