import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import type {
  Engine,
  EngineTurnOutcome,
  EngineTurnRequest,
  RunningTurn,
  SandboxMode,
  TurnUsage,
  WorkerResult,
} from '../schema/types.ts';

export interface CodexEngineOptions {
  command?: string[];
  sandbox?: SandboxMode;
  model?: string;
  env?: NodeJS.ProcessEnv;
}

let npmGlobalRoot: string | undefined;

export function resolveCodexCommand(): string[] {
  const override = process.env.SYNCW_CODEX_COMMAND;
  if (override !== undefined) {
    let command: unknown;
    try {
      command = JSON.parse(override);
    } catch {
      throw new Error('SYNCW_CODEX_COMMAND must be a JSON array of strings, e.g. ["codex"].');
    }
    if (!isStringArray(command) || !command[0]) {
      throw new Error('SYNCW_CODEX_COMMAND must be a nonempty JSON array of strings with an executable first.');
    }
    return command;
  }

  if (process.platform !== 'win32') return ['codex'];
  if (npmGlobalRoot === undefined) {
    try {
      // npm is a .cmd shim on Windows; these constant arguments are the only shell invocation.
      npmGlobalRoot = execFileSync('npm', ['root', '-g'], { shell: true, encoding: 'utf8', windowsHide: true }).trim();
    } catch (error) {
      throw new Error(`Cannot find npm's global root: ${message(error)}. Install npm or set SYNCW_CODEX_COMMAND.`);
    }
  }
  const launcher = path.join(npmGlobalRoot, '@openai', 'codex', 'bin', 'codex.js');
  if (!existsSync(launcher)) {
    throw new Error(`Codex launcher not found at ${launcher}. Install @openai/codex globally or set SYNCW_CODEX_COMMAND.`);
  }
  return [process.execPath, launcher];
}

/** Resume uses config overrides because that subcommand has neither -s nor -C. */
export function buildCodexArgs(
  req: EngineTurnRequest,
  opts: Pick<CodexEngineOptions, 'sandbox' | 'model'> = {},
): string[] {
  const sandbox = opts.sandbox ?? 'danger-full-access';
  const args = req.session_id === undefined
    ? ['exec', '--json', '-s', sandbox, '-c', 'approval_policy="never"', '-C', req.cwd]
    : ['exec', 'resume', req.session_id, '-c', `sandbox_mode="${sandbox}"`, '-c', 'approval_policy="never"', '--json'];
  args.push('--output-schema', req.result_schema_path, '-o', req.result_path);
  if (opts.model) args.push('-m', opts.model);
  args.push('-');
  return args;
}

export function createCodexEngine(opts: CodexEngineOptions = {}): Engine {
  const command = [...(opts.command ?? resolveCodexCommand())];
  return {
    kind: 'codex',
    startTurn: (req) => startTurn(req, command, opts),
  };
}

function startTurn(req: EngineTurnRequest, command: string[], opts: CodexEngineOptions): RunningTurn {
  let resolveSession!: (id: string | undefined) => void;
  let resolveDone!: (outcome: EngineTurnOutcome) => void;
  const sessionId = new Promise<string | undefined>((resolve) => { resolveSession = resolve; });
  const done = new Promise<EngineTurnOutcome>((resolve) => { resolveDone = resolve; });
  const files = new Set<string>();
  const errors: string[] = [];
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let threadId: string | undefined;
  let eventError: string | undefined;
  let usage: TurnUsage | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  let eventsFd: number | undefined;
  let stderrFd: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopping: Promise<void> | undefined;
  let exited = false;
  let finished = false;
  let timedOut = false;
  let cancelled = false;
  const resultPath = path.resolve(req.cwd, req.result_path);

  function parseLine(line: string): void {
    let event: unknown;
    try { event = JSON.parse(line); } catch { return; }
    if (!isObject(event)) return;
    if (event.type === 'thread.started' && typeof event.thread_id === 'string' && threadId === undefined) {
      threadId = event.thread_id;
      resolveSession(threadId);
    } else if (event.type === 'item.completed' && isObject(event.item)
      && event.item.type === 'file_change' && Array.isArray(event.item.changes)) {
      for (const change of event.item.changes) {
        if (!isObject(change) || typeof change.path !== 'string') continue;
        const relative = path.relative(req.cwd, change.path);
        const inside = relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        files.add(inside ? relative.split(path.sep).join('/') : change.path);
      }
    } else if (event.type === 'turn.completed' && isObject(event.usage)
      && typeof event.usage.input_tokens === 'number'
      && typeof event.usage.cached_input_tokens === 'number'
      && typeof event.usage.output_tokens === 'number') {
      usage = {
        input_tokens: event.usage.input_tokens,
        cached_input_tokens: event.usage.cached_input_tokens,
        output_tokens: event.usage.output_tokens,
      };
    } else if (event.type === 'turn.failed' && isObject(event.error) && typeof event.error.message === 'string') {
      eventError = event.error.message;
    } else if (event.type === 'error' && typeof event.message === 'string') {
      eventError = event.message;
    }
  }

  function parseChunk(text: string): void {
    pending += text;
    let end: number;
    while ((end = pending.indexOf('\n')) !== -1) {
      parseLine(pending.slice(0, end));
      pending = pending.slice(end + 1);
    }
  }

  function append(fd: number | undefined, chunk: Buffer, label: string): void {
    if (fd === undefined) return;
    try {
      let offset = 0;
      while (offset < chunk.length) offset += writeSync(fd, chunk, offset, chunk.length - offset);
    } catch (error) {
      const problem = `Cannot append ${label}: ${message(error)}. Check the log path and available disk space.`;
      if (!errors.includes(problem)) errors.push(problem);
    }
  }

  function stop(reason: 'timeout' | 'cancel'): void {
    if (exited || finished || timedOut || cancelled) return;
    timedOut = reason === 'timeout';
    cancelled = reason === 'cancel';
    clearTimeout(timer);
    errors.push(timedOut ? `Codex timed out after ${req.timeout_ms} ms.` : 'Codex turn was cancelled.');
    if (child?.pid !== undefined) {
      stopping = killTree(child.pid).then((error) => {
        if (error && !exited) errors.push(error);
      });
    }
  }

  function complete(code: number | null, signal: NodeJS.Signals | null): void {
    if (finished) return;
    finished = true;
    exited = true;
    clearTimeout(timer);
    parseChunk(decoder.end());
    if (pending) parseLine(pending);
    resolveSession(undefined);
    for (const fd of [eventsFd, stderrFd]) {
      if (fd === undefined) continue;
      try { closeSync(fd); } catch (error) { errors.push(`Cannot close Codex log: ${message(error)}.`); }
    }

    let result: WorkerResult | null = null;
    // A failed launch must never read an older result if preparation did not finish.
    if (child?.pid !== undefined) {
      try {
        const value: unknown = JSON.parse(readFileSync(resultPath, 'utf8'));
        if (isWorkerResult(value)) result = value;
        else errors.push(`Invalid WorkerResult in ${resultPath}: expected status done/failed/blocked, string summary/details, and string arrays files_changed/open_questions.`);
      } catch (error) {
        if (isErrno(error, 'ENOENT')) errors.push(`Missing Codex result file at ${resultPath}; Codex did not write its final result.`);
        else if (error instanceof SyntaxError) errors.push(`Invalid JSON in Codex result file ${resultPath}: ${message(error)}.`);
        else errors.push(`Cannot read Codex result file ${resultPath}: ${message(error)}. Check the result path and permissions.`);
      }
      if (!timedOut && !cancelled) {
        if (code !== null && code !== 0) errors.push(`Codex exited with code ${code}.`);
        else if (signal) errors.push(`Codex was terminated by ${signal}.`);
      }
    }

    function resolve(): void {
      resolveDone({
        session_id: threadId ?? req.session_id,
        exit_code: timedOut || cancelled || child?.pid === undefined ? null : code,
        result,
        files_touched: [...files],
        usage,
        timed_out: timedOut,
        cancelled,
        error: [eventError, ...errors].filter((entry) => entry !== undefined).join('\n') || undefined,
      });
    }
    // taskkill can finish after the launcher closes; wait for the tree operation too.
    if (stopping) void stopping.then(resolve);
    else resolve();
  }

  try {
    try { unlinkSync(resultPath); } catch (error) { if (!isErrno(error, 'ENOENT')) throw error; }
    eventsFd = openSync(path.resolve(req.cwd, req.events_path), 'a');
    stderrFd = openSync(path.resolve(req.cwd, req.stderr_path), 'a');
    const executable = command[0];
    if (!executable) throw new Error('Codex command is empty; supply an executable in command or SYNCW_CODEX_COMMAND');
    child = spawn(executable, [...command.slice(1), ...buildCodexArgs(req, opts)], {
      cwd: req.cwd,
      env: opts.env ?? process.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: 'pipe',
    });
    child.stdout.on('data', (chunk: Buffer) => {
      // Preserve original bytes, including CRLF, non-JSON lines and an unterminated last line.
      append(eventsFd, chunk, 'Codex stdout');
      parseChunk(decoder.write(chunk));
    });
    child.stderr.on('data', (chunk: Buffer) => { append(stderrFd, chunk, 'Codex stderr'); });
    child.stdout.on('error', (error: Error) => { errors.push(`Cannot read Codex stdout: ${message(error)}.`); });
    child.stderr.on('error', (error: Error) => { errors.push(`Cannot read Codex stderr: ${message(error)}.`); });
    child.stdin.on('error', (error: Error) => { errors.push(`Cannot send prompt to Codex: ${message(error)}.`); });
    child.on('error', (error: Error) => { errors.push(`Cannot run Codex: ${message(error)}. Check the command and working directory.`); });
    child.on('exit', () => { exited = true; clearTimeout(timer); });
    child.on('close', complete);
    timer = setTimeout(() => { stop('timeout'); }, req.timeout_ms);
    child.stdin.end(req.prompt, 'utf8');
  } catch (error) {
    errors.push(`Cannot start Codex turn: ${message(error)}. Check the command, working directory and artifact paths.`);
    complete(null, null);
  }

  return { sessionId, done, cancel: () => { stop('cancel'); } };
}

/** Killing only the launcher leaves the Codex executable and its children running. */
function killTree(pid: number): Promise<string | undefined> {
  if (process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGKILL'); } catch (error) {
      if (!isErrno(error, 'ESRCH')) return Promise.resolve(`Cannot kill Codex process group ${pid}: ${message(error)}.`);
    }
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      killer.on('error', (error: Error) => { resolve(`Cannot run taskkill for Codex process ${pid}: ${message(error)}.`); });
      killer.on('close', (code) => { resolve(code === 0 ? undefined : `taskkill failed for Codex process ${pid} with exit code ${code}.`); });
    } catch (error) {
      resolve(`Cannot run taskkill for Codex process ${pid}: ${message(error)}.`);
    }
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string');
}

function isWorkerResult(value: unknown): value is WorkerResult {
  return isObject(value)
    && (value.status === 'done' || value.status === 'failed' || value.status === 'blocked')
    && typeof value.summary === 'string' && typeof value.details === 'string'
    && isStringArray(value.files_changed) && isStringArray(value.open_questions);
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
