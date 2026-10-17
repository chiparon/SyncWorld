import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type {
  AgentRecord,
  CommitInfo,
  EngineTurnOutcome,
  PostOffice,
  PostOfficeLimits,
  PostOfficeOptions,
  RunningTurn,
  SpawnAgentInput,
  TurnRecord,
  TurnReport,
  WaitOutput,
} from '../schema/types.ts';
import { buildFirstPrompt, buildFollowUpPrompt } from './prompt.ts';

export const DEFAULT_LIMITS: PostOfficeLimits = {
  max_parallel: 4,
  max_agents: 12,
  max_turns: 10,
  turn_timeout_ms: 30 * 60_000,
};

interface ActiveTurn {
  started: number;
  handle?: RunningTurn;
  recorded?: Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPending(record: AgentRecord): boolean {
  return record.status === 'running' || record.status === 'queued';
}

export function createPostOffice(opts: PostOfficeOptions): PostOffice {
  const { registry, worktrees, engine } = opts;
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} must be a positive finite number; received ${value}.`);
    }
  }

  const fifo: string[] = [];
  const running = new Map<string, ActiveTurn>();
  const waiters = new Set<() => void>();
  const closing = new Set<string>();
  let spawning = Promise.resolve();
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;

  function requireOpen(): void {
    if (shuttingDown) throw new Error('The post office is shutting down. Restart it to continue.');
  }

  function requireAgent(name: string, allowClosed = false): AgentRecord {
    const record = registry.get(name);
    if (!record) throw new Error(`Unknown agent "${name}". Use list_agents to find an existing agent.`);
    if (!allowClosed && record.status === 'closed') {
      throw new Error(`Agent "${name}" is closed. Spawn a new agent to continue.`);
    }
    if (closing.has(name)) throw new Error(`Agent "${name}" is being closed. Wait for close_agent to finish.`);
    return record;
  }

  function wakeWaiters(): void {
    for (const wake of [...waiters]) wake();
  }

  function pump(): void {
    while (!shuttingDown && running.size < limits.max_parallel && fifo.length) {
      const name = fifo.shift()!;
      const active: ActiveTurn = { started: Date.now() };
      running.set(name, active);
      active.recorded = runTurn(name, active);
    }
  }

  function enqueue(name: string): void {
    registry.update(name, { status: 'queued' });
    fifo.push(name);
    pump();
  }

  /** Retry a failed persistence step without appending an already-saved turn twice. */
  function recoverTurn(name: string, turn: TurnRecord, error: unknown): void {
    turn.facts.error = [turn.facts.error, `Unexpected turn error: ${errorMessage(error)}`].filter(Boolean).join('\n');
    const failures: string[] = [];
    try {
      const record = registry.get(name)!;
      const exists = record.turns.some((saved) => saved.facts.turn === turn.facts.turn);
      registry.update(name, {
        status: shuttingDown ? 'interrupted' : 'idle',
        turns: exists
          ? record.turns.map((saved) => saved.facts.turn === turn.facts.turn ? { ...turn, reported: saved.reported } : saved)
          : [...record.turns, turn],
      });
    } catch (failure) {
      failures.push(errorMessage(failure));
      // A transient append failure must not also leave a stale running status.
      try { registry.update(name, { status: shuttingDown ? 'interrupted' : 'idle' }); } catch (statusError) { failures.push(errorMessage(statusError)); }
    }
    try {
      registry.log('turn.error', { name, turn: turn.facts.turn, error: turn.facts.error, failures });
    } catch (logError) {
      // Persistence can itself fail (for example, a full disk); never reject a background task.
      console.error(`Cannot log turn error for ${name}: ${errorMessage(logError)}. ${turn.facts.error}`, ...failures);
    }
  }

  async function runTurn(name: string, active: ActiveTurn): Promise<void> {
    let input = '';
    const errors: string[] = [];
    let outcome: EngineTurnOutcome = {
      result: null, exit_code: null, files_touched: [], timed_out: false, cancelled: false,
    };
    let commit: CommitInfo | undefined;
    let turn: TurnRecord | undefined;
    let number = 1;

    function makeTurn(): TurnRecord {
      const finished = Date.now();
      return {
        input,
        result: outcome.result,
        facts: {
          turn: number,
          started_at: new Date(active.started).toISOString(),
          finished_at: new Date(finished).toISOString(),
          duration_ms: finished - active.started,
          exit_code: outcome.exit_code,
          files_touched: outcome.files_touched,
          commit: commit?.commit,
          diff_stat: commit?.diff_stat,
          usage: outcome.usage,
          timed_out: outcome.timed_out,
          cancelled: outcome.cancelled,
          error: [outcome.error, ...errors, shuttingDown ? 'The post office shut down during the turn.' : undefined].filter(Boolean).join('\n') || undefined,
        },
        reported: false,
      };
    }

    try {
      const record = registry.get(name)!;
      number = record.turns.length + 1;
      try {
        const first = !record.session_id && record.turns.length === 0;
        input = first ? buildFirstPrompt(record) : buildFollowUpPrompt(record.queued_messages, 'scheduler');
        registry.update(name, { status: 'running' });
        const directory = registry.agentDir(name);
        writeFileSync(join(directory, `turn-${number}.prompt.md`), input, 'utf8');
        active.handle = engine.startTurn({
          cwd: record.worktree,
          prompt: input,
          session_id: record.session_id,
          result_schema_path: opts.result_schema_path,
          result_path: join(directory, `turn-${number}.json`),
          events_path: join(directory, 'events.jsonl'),
          stderr_path: join(directory, 'stderr.log'),
          timeout_ms: limits.turn_timeout_ms,
        });
        // A failed launch has not delivered anything; the first turn cannot deliver messages either.
        if (!first) {
          // Once launched, a persistence failure must not let us stop awaiting the process.
          try { registry.update(name, { queued_messages: [] }); }
          catch (error) { errors.push(`Cannot clear queued messages: ${errorMessage(error)}`); }
        }
        const sessionSaved = active.handle.sessionId.then((session_id) => {
          if (session_id !== undefined && registry.get(name)?.session_id === undefined) {
            registry.update(name, { session_id });
          }
        }).catch((error: unknown) => { errors.push(`Cannot store session id: ${errorMessage(error)}`); });
        outcome = await active.handle.done;
        await sessionSaved;
        if (outcome.session_id !== undefined && registry.get(name)?.session_id === undefined) {
          registry.update(name, { session_id: outcome.session_id });
        }
      } catch (error) {
        errors.push(`Cannot run turn: ${errorMessage(error)}`);
      }

      try {
        const summary = outcome.result ? outcome.result.summary.split(/\r?\n/, 1)[0]!.slice(0, 100) : '(no result)';
        commit = await worktrees.commitAll(record.worktree, `${name} 第 ${number} 轮：${summary}`, {
          name: `${name} (syncw)`, email: `${name}@syncw.local`,
        });
      } catch (error) {
        errors.push(`Auto-commit failed: ${errorMessage(error)}`);
      }

      turn = makeTurn();
      registry.appendTurn(name, turn);
      const status = shuttingDown ? 'interrupted' : outcome.cancelled ? 'cancelled' : 'idle';
      registry.update(name, { status });
      registry.log('turn.finished', {
        name, turn: number, status, result_status: outcome.result?.status ?? null, error: turn.facts.error,
      });
    } catch (error) {
      turn ??= makeTurn();
      recoverTurn(name, turn, error);
    } finally {
      running.delete(name);
      try {
        const record = registry.get(name)!;
        if (active.handle && !shuttingDown && !outcome.cancelled && record.queued_messages.length && record.turns.length < limits.max_turns) {
          enqueue(name);
        }
      } catch (error) {
        recoverTurn(name, turn ?? makeTurn(), error);
      }
      pump();
      wakeWaiters();
    }
  }

  async function spawn(input: SpawnAgentInput) {
    requireOpen();
    if (typeof input.task?.goal !== 'string' || !input.task.goal.trim()) {
      throw new Error('task.goal must be a non-empty string. Describe the outcome the agent should achieve.');
    }
    if (!input.role?.trim() && !input.brief?.trim()) {
      throw new Error('Provide at least one of role or brief to describe the agent\'s role.');
    }
    if (registry.list().length >= limits.max_agents) {
      throw new Error(`This run has reached max_agents (${limits.max_agents}), including closed agents. To begin a new run, close this run's remaining agents and restart the post office, or start it with --new-run.`);
    }
    const role = input.role ?? 'custom';
    let brief = input.brief ?? '';
    if (input.role !== undefined) {
      const available = readdirSync(opts.roles_dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map((entry) => entry.name.slice(0, -3)).sort();
      if (!available.includes(role)) {
        throw new Error(`Unknown role "${role}". Available roles: ${available.join(', ') || '(none)'}. Choose one or provide only a brief.`);
      }
      brief = readFileSync(join(opts.roles_dir, `${role}.md`), 'utf8');
      if (input.brief !== undefined) brief += `\n\n${input.brief}`;
    }
    const repo = resolve(input.repo ?? opts.default_repo);
    // Branches and worktrees outlive runs, and run names restart at 1.
    const taken = await worktrees.usedNames(repo);
    requireOpen();
    const name = registry.allocateName(role, taken);
    const created = await worktrees.create(repo, name, input.base);
    const record: AgentRecord = {
      name, role, brief, task: input.task, engine: engine.kind, hired_by: 'scheduler', repo,
      ...created, status: shuttingDown ? 'interrupted' : 'queued', turns: [], queued_messages: [], created_at: new Date().toISOString(),
    };
    registry.add(record);
    registry.log('agent.spawned', { name, role, repo, ...created });
    if (!shuttingDown) enqueue(name);
    return { name, branch: created.branch, worktree: created.worktree, status: registry.get(name)!.status };
  }

  function collect(names: string[]): WaitOutput {
    const finished: TurnReport[] = [];
    const pending: string[] = [];
    for (const name of names) {
      const record = registry.get(name)!;
      const unreported = record.turns.filter((turn) => !turn.reported);
      if (unreported.length) {
        registry.update(name, { turns: record.turns.map((turn) => ({ ...turn, reported: true })) });
        finished.push(...unreported.map((turn) => ({ agent: name, turn: turn.facts.turn, result: turn.result, facts: turn.facts })));
      }
      if (isPending(record)) pending.push(name);
    }
    finished.sort((a, b) => a.facts.finished_at.localeCompare(b.facts.finished_at));
    return { finished, pending };
  }

  return {
    async spawnAgent(input) {
      requireOpen();
      // Worktree creation yields; reserve names and agent capacity by serializing this operation.
      const result = spawning.then(() => spawn(input));
      spawning = result.then(() => {}, () => {});
      return result;
    },
    async sendMessage({ to, text }) {
      requireOpen();
      const record = requireAgent(to);
      if (record.turns.length + (isPending(record) ? 1 : 0) >= limits.max_turns) {
        throw new Error(`Agent "${to}" has reached max_turns (${limits.max_turns}). Spawn a new agent to continue.`);
      }
      if (!isPending(record) && !record.session_id && record.turns.length) {
        throw new Error(`Agent "${to}" has no session_id: there is nothing to resume because the first turn never started. Spawn a new agent to continue.`);
      }
      registry.update(to, { queued_messages: [...record.queued_messages, text] });
      if (isPending(record)) return { delivery: 'queued' };
      enqueue(to);
      return { delivery: registry.get(to)!.status === 'running' ? 'started' : 'queued' };
    },
    async wait({ agents, timeout_s = 600 }) {
      requireOpen();
      const names = [...new Set(agents ?? registry.list().map((record) => record.name))];
      for (const name of names) {
        if (!registry.get(name)) throw new Error(`Unknown agent "${name}". Use list_agents to find an existing agent.`);
      }
      if (!Number.isFinite(timeout_s) || timeout_s < 0) throw new Error('timeout_s must be a non-negative finite number.');
      const immediate = collect(names);
      if (immediate.finished.length || !immediate.pending.length || timeout_s === 0) return immediate;
      return new Promise<WaitOutput>((resolveWait, rejectWait) => {
        const finish = (timedOut = false): void => {
          try {
            requireOpen();
            const output = collect(names);
            if (!timedOut && !output.finished.length && output.pending.length) return;
            clearTimeout(timer);
            waiters.delete(wake);
            resolveWait(output);
          } catch (error) {
            clearTimeout(timer);
            waiters.delete(wake);
            rejectWait(error);
          }
        };
        const wake = () => { finish(); };
        const timer = setTimeout(() => { finish(true); }, timeout_s * 1000);
        waiters.add(wake);
      });
    },
    listAgents() {
      return registry.list().map((record) => ({
        name: record.name, role: record.role, status: record.status, branch: record.branch, worktree: record.worktree,
        turns: record.turns.length, queued_messages: record.queued_messages.length,
        running_for_s: running.has(record.name) ? (Date.now() - running.get(record.name)!.started) / 1000 : undefined,
        last_summary: record.turns.at(-1)?.result?.summary,
      }));
    },
    async cancelAgent(name) {
      const record = requireAgent(name);
      if (record.status === 'running') {
        running.get(name)?.handle?.cancel();
      } else if (record.status === 'queued') {
        const index = fifo.indexOf(name);
        if (index !== -1) fifo.splice(index, 1);
        registry.update(name, { status: 'cancelled' });
        pump();
        wakeWaiters();
      }
    },
    async closeAgent(name, options) {
      const record = requireAgent(name, true);
      if (isPending(record)) throw new Error(`Agent "${name}" is ${record.status}; cancel it first before closing it.`);
      if (record.status === 'closed') return;
      closing.add(name);
      try {
        await worktrees.remove(record.repo, record.worktree, { deleteBranch: options?.delete_branch ? record.branch : undefined });
        registry.update(name, { status: 'closed' });
        registry.log('agent.closed', { name });
      } finally {
        closing.delete(name);
      }
    },
    shutdown() {
      // Event-driven shutdown relies on pump() assigning the handle and recorded promise synchronously.
      if (shutdownPromise) return shutdownPromise;
      shuttingDown = true;
      wakeWaiters();
      fifo.length = 0;
      for (const record of registry.list()) {
        if (record.status === 'queued') registry.update(record.name, { status: 'interrupted' });
      }
      for (const active of running.values()) active.handle?.cancel();
      // Include in-flight worktree creation so callers can safely close the registry afterwards.
      shutdownPromise = Promise.all([spawning, ...[...running.values()].map((active) => active.recorded)]).then(() => {});
      return shutdownPromise;
    },
  };
}
