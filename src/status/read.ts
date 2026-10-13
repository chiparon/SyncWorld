import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { AgentRecord, AgentStatusView, RunStatus } from '../schema/types.ts';

export interface ReadStatusOptions {
  runsDir: string;
  runId?: string;
  /** Milliseconds since the epoch, like Date.now. */
  now?: () => number;
}

function readAgents(file: string, allowMissing = false): AgentRecord[] | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Cannot read "${file}". Check that agents.json exists and is a readable file.`);
  }
  let records: unknown;
  try {
    records = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON in "${file}". Repair or restore agents.json before retrying.`);
  }
  if (!Array.isArray(records)) {
    throw new Error(`Expected an array in "${file}". Repair or restore agents.json as an array of agents.`);
  }
  for (const [index, value] of (records as unknown[]).entries()) {
    const record = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
    const invalidField = (field: string, expected: string) => new Error(
      `Invalid field "${field}" at record index ${index} in "${file}": expected ${expected}. Repair or restore agents.json before retrying.`,
    );
    for (const field of ['name', 'role', 'status', 'branch']) {
      if (typeof record[field] !== 'string') throw invalidField(field, 'a string');
    }
    const task = record.task;
    if (task === null || typeof task !== 'object' || !('goal' in task) || typeof task.goal !== 'string') {
      throw invalidField('task.goal', 'a string');
    }
    for (const field of ['turns', 'queued_messages']) {
      if (!Array.isArray(record[field])) throw invalidField(field, 'an array');
    }
  }
  return records as AgentRecord[];
}

/** Ignore empty health-check runs and old runs, but surface broken state files. */
export function findLatestRun(runsDir: string): string | undefined {
  const directory = resolve(runsDir);
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Cannot read runs directory "${directory}". Check its permissions or set SYNCW_RUNS_DIR to a readable directory.`);
  }
  const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  for (const name of names) {
    const agents = readAgents(join(directory, name, 'agents.json'), true);
    if (agents && agents.length > 0) return name;
  }
  return undefined;
}

export function readRunStatus(opts: ReadStatusOptions): RunStatus {
  const runsDir = resolve(opts.runsDir);
  const runId = opts.runId ?? findLatestRun(runsDir);
  if (runId === undefined) {
    throw new Error(
      `No run with agents in "${runsDir}". Start a Syncw run and hire an agent, or set SYNCW_RUNS_DIR to an existing runs directory.`,
    );
  }
  const runDir = join(runsDir, runId);
  if (opts.runId !== undefined) {
    const unknownRun = () => new Error(
      `Unknown run ${JSON.stringify(runId)} in "${runsDir}". Choose an existing run id with --run, or omit --run for the latest run.`,
    );
    if (!runId || runId === '.' || runId === '..' || /[\\/]/.test(runId)) throw unknownRun();
    try {
      if (!statSync(runDir).isDirectory()) throw unknownRun();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw unknownRun();
      throw error;
    }
  }
  const records = readAgents(join(runDir, 'agents.json'))!;
  const now = (opts.now ?? Date.now)();
  const agents = records.map((record): AgentStatusView => {
    const agent: AgentStatusView = {
      name: record.name,
      role: record.role,
      status: record.status,
      branch: record.branch,
      goal: record.task.goal,
      turns: record.turns.length,
      queued_messages: record.queued_messages.length,
    };
    const last = record.turns.at(-1);
    if (last) agent.last_turn = { result: last.result, facts: last.facts };
    if (record.status === 'running') {
      const prompt = join(runDir, record.name, `turn-${record.turns.length + 1}.prompt.md`);
      try {
        agent.running_for_s = Math.max(0, Math.floor((now - statSync(prompt).mtimeMs) / 1000));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error(`Cannot read modification time of "${prompt}". Check that the prompt file is accessible.`);
        }
      }
    }
    return agent;
  });
  return { run_id: runId, run_dir: runDir, agents };
}
