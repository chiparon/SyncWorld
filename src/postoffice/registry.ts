import { randomInt, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import type { AgentRecord, OpenRegistryOptions, Registry } from '../schema/types.ts';
import { findLatestRun } from '../status/read.ts';

function newRunId(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${date}-${time}-${randomInt(36 ** 4).toString(36).padStart(4, '0')}`;
}

function claimRun(runDir: string): boolean {
  const ownClaim = join(runDir, `owner-${process.pid}.json`);
  let claimed = false;
  try {
    writeFileSync(ownClaim, `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`);
    for (const name of readdirSync(runDir)) {
      const match = /^owner-(\d+)\.json$/.exec(name);
      if (!match) continue;
      const pid = Number(match[1]);
      if (pid === process.pid) continue;
      let live = false;
      try {
        process.kill(pid, 0);
        live = true;
      } catch (error) {
        live = (error as NodeJS.ErrnoException).code === 'EPERM';
      }
      if (live) return false;
      rmSync(join(runDir, name), { force: true });
    }
    claimed = true;
    return true;
  } finally {
    if (!claimed) rmSync(ownClaim, { force: true });
  }
}

function repoPath(repo: string): string {
  const absolute = resolve(repo);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

export function openRegistry(opts: OpenRegistryOptions): Registry {
  const runsDir = resolve(opts.runsDir);
  const repo = opts.repo === undefined ? undefined : repoPath(opts.repo);
  let candidateAgents: AgentRecord[] = [];
  const candidate = opts.mode === 'new' ? undefined : findLatestRun(runsDir, (agents) => {
    if (repo !== undefined && !agents.some((agent) => repoPath(agent.repo) === repo)) return false;
    candidateAgents = agents;
    return true;
  });
  const reopening = candidate !== undefined
    && candidateAgents.some((agent) => agent.status !== 'closed')
    && claimRun(join(runsDir, candidate));
  const runId = reopening ? candidate! : newRunId();

  const runDir = join(runsDir, runId);
  const statePath = join(runDir, 'agents.json');
  const ownClaim = join(runDir, `owner-${process.pid}.json`);
  let onDisk = reopening;
  let closed = false;
  let records: AgentRecord[] = [];

  function writeState(next: AgentRecord[]): void {
    const temporaryPath = join(runDir, `agents.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' });
      renameSync(temporaryPath, statePath);
      // Failed writes must leave the in-memory state consistent with the last saved file.
      records = next;
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }

  function ensureOnDisk(): void {
    if (closed) throw new Error('This registry is closed. Open a registry before writing again.');
    if (onDisk) return;
    mkdirSync(runsDir, { recursive: true });
    try {
      mkdirSync(runDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      throw new Error(`Cannot create run "${runDir}": the directory already exists. Open a new registry to get a new run id and retry.`);
    }
    if (!claimRun(runDir)) {
      throw new Error(`Cannot claim run "${runDir}": another live post office owns it. Open a new registry and retry.`);
    }
    onDisk = true;
    writeState(records);
  }

  function persist(next: AgentRecord[]): void {
    ensureOnDisk();
    writeState(next);
  }

  function requireRecord(name: string): AgentRecord {
    const record = records.find((agent) => agent.name === name);
    if (!record) throw new Error(`Unknown agent "${name}". Add the agent before updating it.`);
    return record;
  }

  const registry: Registry = {
    runId,
    runDir,
    allocateName(role, taken) {
      const used = (name: string) => records.some((agent) => agent.name === name) || taken?.has(name) === true;
      let number = 1;
      while (used(`${role}-${number}`)) number++;
      return `${role}-${number}`;
    },
    add(record) {
      if (records.some((agent) => agent.name === record.name)) {
        throw new Error(`Agent "${record.name}" already exists in this run. Allocate a new name.`);
      }
      persist([...records, structuredClone(record)]);
    },
    get(name) {
      return structuredClone(records.find((agent) => agent.name === name));
    },
    list() {
      return structuredClone(records);
    },
    update(name, patch) {
      const record = requireRecord(name);
      if ('name' in patch && patch.name !== name) {
        throw new Error(`Cannot rename agent "${name}". Keep its original name when updating it.`);
      }
      const updated = { ...record, ...structuredClone(patch), name };
      persist(records.map((agent) => (agent.name === name ? updated : agent)));
      return structuredClone(updated);
    },
    appendTurn(name, turn) {
      return registry.update(name, { turns: [...requireRecord(name).turns, turn] });
    },
    agentDir(name) {
      ensureOnDisk();
      const directory = join(runDir, name);
      mkdirSync(directory, { recursive: true });
      return directory;
    },
    log(event, data) {
      ensureOnDisk();
      appendFileSync(
        join(runDir, 'log.jsonl'),
        `${JSON.stringify({ ts: new Date().toISOString(), event, ...data })}\n`,
      );
    },
    close() {
      if (closed) return;
      if (onDisk) rmSync(ownClaim, { force: true });
      closed = true;
    },
  };

  if (reopening) {
    try {
      // Read again after claiming: a previous owner may have saved while we were selecting.
      records = JSON.parse(readFileSync(statePath, 'utf8'));
      if (!records.some((agent) => agent.status !== 'closed')) {
        registry.close();
        return openRegistry({ ...opts, mode: 'new' });
      }
      const interrupted = records
        .filter((agent) => agent.status === 'queued' || agent.status === 'running')
        .map((agent) => agent.name);
      persist(records.map((agent) => (
        interrupted.includes(agent.name) ? { ...agent, status: 'interrupted' } : agent
      )));
      registry.log('registry.reopened', { interrupted });
    } catch (error) {
      registry.close();
      throw error;
    }
  }

  return registry;
}
