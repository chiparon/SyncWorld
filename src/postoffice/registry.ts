import { randomInt, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import type { AgentRecord, OpenRegistryOptions, Registry } from '../schema/types.ts';

function newRunId(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${date}-${time}-${randomInt(36 ** 4).toString(36).padStart(4, '0')}`;
}

export function openRegistry(opts: OpenRegistryOptions): Registry {
  const runsDir = resolve(opts.runsDir);
  mkdirSync(runsDir, { recursive: true });

  // Placeholder until the run lifecycle lands: 'continue' reopens the newest run with state.
  let runId = opts.mode === 'continue'
    ? readdirSync(runsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(runsDir, entry.name, 'agents.json')))
        .map((entry) => entry.name)
        .sort()
        .at(-1)
    : undefined;
  const reopening = runId !== undefined;

  if (runId === undefined) {
    // Exclusive creation also keeps two runs started in the same second separate.
    for (;;) {
      runId = newRunId();
      try {
        mkdirSync(join(runsDir, runId));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
  }

  const runDir = join(runsDir, runId);
  const statePath = join(runDir, 'agents.json');
  let records: AgentRecord[] = reopening ? JSON.parse(readFileSync(statePath, 'utf8')) : [];

  function persist(next: AgentRecord[]): void {
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
      const directory = join(runDir, name);
      mkdirSync(directory, { recursive: true });
      return directory;
    },
    log(event, data) {
      appendFileSync(
        join(runDir, 'log.jsonl'),
        `${JSON.stringify({ ts: new Date().toISOString(), event, ...data })}\n`,
      );
    },
    // Placeholder until the run lifecycle lands: there is no claim to release yet.
    close() {},
  };

  const interrupted = records
    .filter((agent) => agent.status === 'queued' || agent.status === 'running')
    .map((agent) => agent.name);
  persist(records.map((agent) => (
    interrupted.includes(agent.name) ? { ...agent, status: 'interrupted' } : agent
  )));
  if (reopening) registry.log('registry.reopened', { interrupted });

  return registry;
}
