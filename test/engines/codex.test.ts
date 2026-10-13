import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { buildCodexArgs, createCodexEngine, resolveCodexCommand } from '../../src/engines/codex.ts';
import type { CodexEngineOptions } from '../../src/engines/codex.ts';
import type { EngineTurnRequest, RunningTurn, WorkerResult } from '../../src/schema/types.ts';

const fake = fileURLToPath(new URL('../fake-codex/codex.ts', import.meta.url));
const launcher = fileURLToPath(new URL('../fake-codex/launcher.ts', import.meta.url));
const stream = fileURLToPath(new URL('../fake-codex/stream.ts', import.meta.url));
const schema = fileURLToPath(new URL('../../src/schema/result.schema.json', import.meta.url));
const validResult: WorkerResult = { status: 'done', summary: 'ok', details: '', files_changed: [], open_questions: [] };

async function fixture(t: TestContext, options: CodexEngineOptions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'syncw-codex-'));
  const cwd = path.join(root, 'work tree');
  const home = path.join(root, 'sessions');
  const turns: RunningTurn[] = [];
  t.after(async () => {
    for (const turn of turns) turn.cancel();
    await Promise.all(turns.map((turn) => turn.done));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(cwd);
  const engine = createCodexEngine({
    command: [process.execPath, fake],
    env: { ...process.env, FAKE_CODEX_HOME: home },
    ...options,
  });
  const req: EngineTurnRequest = {
    cwd,
    prompt: 'A plain prompt.',
    result_schema_path: schema,
    result_path: path.join(cwd, 'result.json'),
    events_path: path.join(cwd, 'events.jsonl'),
    stderr_path: path.join(cwd, 'stderr.log'),
    timeout_ms: 10_000,
  };
  return {
    root, cwd, home, req, engine,
    start(overrides: Partial<EngineTurnRequest> = {}) {
      const turn = engine.startTurn({ ...req, ...overrides });
      turns.push(turn);
      return turn;
    },
  };
}

async function processIds(stderrPath: string): Promise<number[]> {
  const records = (await readFile(stderrPath, 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as { launcher_pid: number; child_pid: number });
  const pids = [...new Set(records.flatMap((record) => [record.launcher_pid, record.child_pid]))];
  assert.equal(pids.length, 3, 'the fixture started a launcher, child and grandchild');
  return pids;
}

function assertGone(pids: number[]): void {
  for (const pid of pids) {
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `process ${pid} must be gone`);
  }
}

describe('Codex engine', { timeout: 20_000 }, () => {
  test('new turn resolves its session early, parses the result and appends raw events', async (t) => {
    const f = await fixture(t, { model: 'fake-model', sandbox: 'workspace-write' });
    await writeFile(f.req.events_path, 'previous log\n');
    const prompt = '  Hello 你好\r\nFAKE: write nested/note.txt first\r\nFAKE: write nested/note.txt second\r\nFAKE: sleep 300\r\nMore context.  ';
    const turn = f.start({ prompt });
    let completed = false;
    void turn.done.then(() => { completed = true; });
    const sessionId = await turn.sessionId;
    assert.match(sessionId ?? '', /^[\da-f-]{36}$/);
    assert.equal(completed, false, 'session is available before the result');
    const outcome = await turn.done;
    assert.equal(f.engine.kind, 'codex');
    assert.equal(outcome.session_id, sessionId);
    assert.equal(outcome.exit_code, 0);
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.cancelled, false);
    assert.equal(outcome.timed_out, false);
    assert.deepEqual(outcome.files_touched, ['nested/note.txt']);
    assert.deepEqual(outcome.usage, { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 });
    assert.deepEqual(outcome.result, {
      status: 'done', summary: `fake turn 1 of session ${sessionId}`,
      details: 'Hello 你好\nMore context.', files_changed: ['nested/note.txt', 'nested/note.txt'], open_questions: [],
    });
    assert.equal(await readFile(path.join(f.cwd, 'nested', 'note.txt'), 'utf8'), 'second');
    const changes = ['add', 'update'].map((kind) => ({
      type: 'item.completed', item: { type: 'file_change', changes: [{ path: path.join(f.cwd, 'nested', 'note.txt'), kind }] },
    }));
    const expected = [
      { type: 'thread.started', thread_id: sessionId }, { type: 'turn.started' }, ...changes,
      { type: 'turn.completed', usage: outcome.usage },
    ];
    assert.equal(await readFile(f.req.events_path, 'utf8'), `previous log\n${expected.map((event) => JSON.stringify(event)).join('\n')}\n`);
  });

  test('resume retains the session and advances the counter using the process cwd', async (t) => {
    const f = await fixture(t);
    const first = await f.start().done;
    assert.ok(first.session_id);
    const second = f.start({ session_id: first.session_id, prompt: 'Follow up.\nFAKE: write resumed.txt continued' });
    assert.equal(await second.sessionId, first.session_id);
    const outcome = await second.done;
    assert.equal(outcome.session_id, first.session_id);
    assert.equal(outcome.result?.summary, `fake turn 2 of session ${first.session_id}`);
    assert.equal(outcome.result?.details, 'Follow up.');
    assert.deepEqual(outcome.files_touched, ['resumed.txt']);
    assert.equal(await readFile(path.join(f.cwd, 'resumed.txt'), 'utf8'), 'continued');
    assert.deepEqual(JSON.parse(await readFile(path.join(f.home, `${first.session_id}.json`), 'utf8')), { turns: 2 });
  });

  test('argv distinguishes new sessions from resume and always overrides the resume sandbox', async (t) => {
    const { req } = await fixture(t);
    assert.deepEqual(buildCodexArgs(req), [
      'exec', '--json', '-s', 'danger-full-access', '-c', 'approval_policy="never"', '-C', req.cwd,
      '--output-schema', schema, '-o', req.result_path, '-',
    ]);
    for (const sandbox of ['read-only', 'workspace-write', 'danger-full-access'] as const) {
      const args = buildCodexArgs({ ...req, session_id: 'known-session' }, { sandbox, model: 'test-model' });
      assert.deepEqual(args, [
        'exec', 'resume', 'known-session', '-c', `sandbox_mode="${sandbox}"`, '-c', 'approval_policy="never"',
        '--json', '--output-schema', schema, '-o', req.result_path, '-m', 'test-model', '-',
      ]);
      assert.equal(args.includes('-s'), false);
      assert.equal(args.includes('-C'), false);
      assert.equal(args.includes(req.prompt), false);
    }
    assert.ok(buildCodexArgs({ ...req, session_id: 'known-session' }).includes('sandbox_mode="danger-full-access"'));
  });

  test('turn.failed preserves its error together with a missing-result explanation', async (t) => {
    const f = await fixture(t);
    const outcome = await f.start({ prompt: 'FAKE: fail-turn deliberate failure' }).done;
    assert.equal(outcome.exit_code, 1);
    assert.equal(outcome.result, null);
    assert.match(outcome.error ?? '', /deliberate failure/);
    assert.match(outcome.error ?? '', /Missing Codex result file/);
  });

  for (const directive of ['bad-result', 'no-result']) {
    test(`${directive} returns null with an explanatory error`, async (t) => {
      const f = await fixture(t);
      const outcome = await f.start({ prompt: `FAKE: ${directive}` }).done;
      assert.equal(outcome.result, null);
      assert.match(outcome.error ?? '', directive === 'bad-result' ? /Invalid JSON/ : /Missing Codex result file/);
    });
  }

  test('validates every WorkerResult field without imposing extra schema checks', async (t) => {
    const f = await fixture(t);
    const invalid: unknown[] = [
      null, [], { ...validResult, status: 'unknown' }, { ...validResult, summary: 42 },
      { ...validResult, details: null }, { ...validResult, files_changed: 'file' },
      { ...validResult, files_changed: [42] }, { ...validResult, open_questions: [null] },
      { status: 'done', summary: '', details: '', files_changed: [] },
    ];
    for (const value of invalid) {
      const outcome = await f.start({ prompt: `FAKE: write result.json ${JSON.stringify(value)}\nFAKE: no-result` }).done;
      assert.equal(outcome.result, null);
      assert.match(outcome.error ?? '', /Invalid WorkerResult/);
    }
    for (const status of ['done', 'failed', 'blocked'] as const) {
      const outcome = await f.start({ prompt: `FAKE: status ${status}` }).done;
      assert.equal(outcome.result?.status, status);
      assert.equal(outcome.error, undefined);
    }
  });

  test('timeout kills the launcher, child and grandchild before done resolves', async (t) => {
    const f = await fixture(t, { command: [process.execPath, launcher] });
    const turn = f.start({ prompt: 'FAKE: sleep 30000', timeout_ms: 1500 });
    assert.ok(await turn.sessionId);
    const pids = await processIds(f.req.stderr_path);
    const outcome = await turn.done;
    assert.equal(outcome.timed_out, true);
    assert.equal(outcome.cancelled, false);
    assert.equal(outcome.exit_code, null);
    assert.equal(outcome.result, null);
    assert.match(outcome.error ?? '', /timed out/);
    assertGone(pids);
  });

  test('cancel is idempotent, kills the tree and is a no-op after exit', async (t) => {
    const f = await fixture(t, { command: [process.execPath, launcher] });
    const turn = f.start({ prompt: 'FAKE: sleep 30000' });
    assert.ok(await turn.sessionId);
    const pids = await processIds(f.req.stderr_path);
    turn.cancel();
    turn.cancel();
    const outcome = await turn.done;
    assert.equal(outcome.cancelled, true);
    assert.equal(outcome.timed_out, false);
    assert.equal(outcome.exit_code, null);
    assertGone(pids);
    turn.cancel();
    assert.strictEqual(await turn.done, outcome);
    const completed = f.start();
    const successful = await completed.done;
    completed.cancel();
    assert.equal(successful.cancelled, false);
    assert.equal(successful.error, undefined);
  });

  test('cancel immediately works without waiting for a session id', async (t) => {
    const f = await fixture(t);
    const turn = f.start({ prompt: 'FAKE: sleep 30000' });
    turn.cancel();
    const outcome = await turn.done;
    assert.equal(outcome.cancelled, true);
    // taskkill may take long enough for a session event to arrive during cancellation.
    assert.equal(await turn.sessionId, outcome.session_id);
  });

  test('a stale result from the previous turn is deleted before starting', async (t) => {
    const f = await fixture(t);
    const previous = await f.start().done;
    assert.ok(previous.result);
    const outcome = await f.start({ session_id: previous.session_id, prompt: 'FAKE: no-result' }).done;
    assert.equal(outcome.result, null);
    assert.match(outcome.error ?? '', /Missing Codex result file/);
    await assert.rejects(readFile(f.req.result_path), { code: 'ENOENT' });
  });

  test('unknown resume session emits an error and falls back only in the outcome', async (t) => {
    const f = await fixture(t);
    const turn = f.start({ session_id: 'unknown-session' });
    assert.equal(await turn.sessionId, undefined);
    const outcome = await turn.done;
    assert.equal(outcome.session_id, 'unknown-session');
    assert.equal(outcome.exit_code, 1);
    assert.equal(outcome.result, null);
    assert.match(outcome.error ?? '', /Unknown fake Codex session/);
  });

  test('nonzero exit preserves a valid result and reports the exit code', async (t) => {
    const f = await fixture(t);
    const outcome = await f.start({ prompt: 'FAKE: exit 7' }).done;
    assert.equal(outcome.exit_code, 7);
    assert.equal(outcome.result?.status, 'done');
    assert.match(outcome.error ?? '', /exited with code 7/);
  });

  test('spawn failure settles both promises without rejecting', async (t) => {
    const f = await fixture(t, { command: [path.join(tmpdir(), 'syncw-no-such-codex-executable')] });
    const turn = f.start({ session_id: 'known-session' });
    assert.equal(await turn.sessionId, undefined);
    const outcome = await turn.done;
    assert.equal(outcome.session_id, 'known-session');
    assert.equal(outcome.exit_code, null);
    assert.equal(outcome.result, null);
    assert.match(outcome.error ?? '', /Cannot run Codex/);
  });

  test('preparation failure is an outcome and never reads a stale result', async (t) => {
    const f = await fixture(t);
    await writeFile(f.req.result_path, JSON.stringify(validResult));
    const turn = f.start({ events_path: path.join(f.cwd, 'missing-dir', 'events.jsonl') });
    assert.equal(await turn.sessionId, undefined);
    const outcome = await turn.done;
    assert.equal(outcome.result, null);
    assert.match(outcome.error ?? '', /Cannot start Codex turn/);
    await assert.rejects(readFile(f.req.result_path), { code: 'ENOENT' });
  });

  test('relative artifact paths are resolved from the worker cwd', async (t) => {
    const f = await fixture(t);
    const outcome = await f.start({ result_path: 'result.json', events_path: 'events.jsonl', stderr_path: 'stderr.log' }).done;
    assert.equal(outcome.result?.status, 'done');
    assert.equal(outcome.error, undefined);
    assert.ok((await readFile(f.req.events_path, 'utf8')).includes('thread.started'));
  });

  test('preserves fragmented raw output, ignores non-events, normalizes paths and keeps the last event error', async (t) => {
    const f = await fixture(t, { command: [process.execPath, stream] });
    await writeFile(f.req.stderr_path, 'previous stderr\n');
    const turn = f.start();
    assert.equal(await turn.sessionId, 'stream-session');
    const outcome = await turn.done;
    assert.deepEqual(outcome.result, { ...validResult, summary: '', extra: 'allowed' });
    assert.deepEqual(outcome.files_touched, ['nested/你好.txt', path.join(`${f.cwd}-sibling`, 'external.txt')]);
    assert.deepEqual(outcome.usage, { input_tokens: 3, cached_input_tokens: 2, output_tokens: 1 });
    assert.equal(outcome.error, 'last error');
    assert.deepEqual(await readFile(f.req.events_path), await readFile(path.join(f.cwd, 'expected-stdout.bin')));
    assert.equal(await readFile(f.req.stderr_path, 'utf8'), 'previous stderr\nraw stderr 你好\r\nlast line');
  });

  test('fake requires FAKE_CODEX_HOME and exits 2 with a useful message', async (t) => {
    const env = { ...process.env };
    delete env.FAKE_CODEX_HOME;
    const f = await fixture(t, { env });
    const outcome = await f.start().done;
    assert.equal(outcome.exit_code, 2);
    assert.equal(outcome.result, null);
    assert.match(await readFile(f.req.stderr_path, 'utf8'), /FAKE_CODEX_HOME is required/);
  });
});

test('SYNCW_CODEX_COMMAND overrides resolution and validates its JSON array', (t) => {
  const previous = process.env.SYNCW_CODEX_COMMAND;
  t.after(() => {
    if (previous === undefined) delete process.env.SYNCW_CODEX_COMMAND;
    else process.env.SYNCW_CODEX_COMMAND = previous;
  });
  const command = [process.execPath, 'a path with spaces/codex.ts', '--custom'];
  process.env.SYNCW_CODEX_COMMAND = JSON.stringify(command);
  assert.deepEqual(resolveCodexCommand(), command);
  for (const invalid of ['', 'not json', '{}', '[]', '[""]', '["codex",1]']) {
    process.env.SYNCW_CODEX_COMMAND = invalid;
    assert.throws(resolveCodexCommand, /SYNCW_CODEX_COMMAND/);
  }
});

test('real Codex responds in a temporary git repository', { skip: process.env.SYNCW_REAL_CODEX !== '1', timeout: 120_000 }, async (t) => {
  const f = await fixture(t, { command: resolveCodexCommand() });
  await promisify(execFile)('git', ['init', '-q', f.cwd], { windowsHide: true });
  const outcome = await f.start({
    prompt: 'Return the required JSON result with status done, summary "hello", empty details and empty arrays. Do not use tools or change files.',
    timeout_ms: 90_000,
  }).done;
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.result?.status, 'done');
  assert.ok(outcome.session_id);
});
