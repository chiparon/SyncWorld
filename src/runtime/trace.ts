/**
 * The Chronicle - an append-only, replayable record of everything a run did.
 *
 * The trace is not a debugging afterthought; it is the product. Replay, diff,
 * eval, and eventually self-tuning routing all read from this file. Design it
 * first, ship the features later.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { RunMeta, TraceEvent, TraceEventType } from '../schema/types.ts';

export interface RecordOptions {
  node?: string;
  item?: number;
}

export class Chronicle {
  readonly runId: string;
  private seq = 0;
  readonly events: TraceEvent[] = [];

  constructor(runId: string) {
    this.runId = runId;
  }

  record(type: TraceEventType, data: Record<string, unknown> = {}, opts: RecordOptions = {}): TraceEvent {
    const event: TraceEvent = {
      seq: this.seq++,
      ts: new Date().toISOString(),
      type,
      data,
    };
    if (opts.node !== undefined) event.node = opts.node;
    if (opts.item !== undefined) event.item = opts.item;
    this.events.push(event);
    return event;
  }

  toJSONL(): string {
    return this.events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  }

  static parseJSONL(text: string): TraceEvent[] {
    return text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as TraceEvent);
  }
}

// ---------------------------------------------------------------------------
// Run store
// ---------------------------------------------------------------------------

export interface RunHandle {
  runId: string;
  dir: string;
}

export class RunStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  static open(projectRoot: string): RunStore {
    return new RunStore(resolve(projectRoot, 'runs'));
  }

  newRunId(workflowName: string): string {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
    const slug = workflowName.replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase();
    return `${stamp}-${slug}-${Math.random().toString(36).slice(2, 6)}`;
  }

  create(runId: string): RunHandle {
    const dir = join(this.root, runId);
    mkdirSync(dir, { recursive: true });
    return { runId, dir };
  }

  dir(runId: string): string {
    return join(this.root, runId);
  }

  exists(runId: string): boolean {
    return existsSync(join(this.dir(runId), 'meta.json'));
  }

  list(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(this.root, d.name, 'meta.json')))
      .map((d) => d.name)
      .sort();
  }

  /** Accept an exact run id or an unambiguous prefix. */
  resolveId(partial: string): string {
    if (this.exists(partial)) return partial;
    const hits = this.list().filter((id) => id.startsWith(partial) || id.includes(partial));
    if (hits.length === 0) {
      throw new Error(`no run matches "${partial}". Known runs:\n  ${this.list().join('\n  ') || '(none)'}`);
    }
    if (hits.length > 1) {
      throw new Error(`"${partial}" is ambiguous:\n  ${hits.join('\n  ')}`);
    }
    return hits[0]!;
  }

  write(handle: RunHandle, chronicle: Chronicle, meta: RunMeta, world: Record<string, unknown>): void {
    writeFileSync(join(handle.dir, 'trace.jsonl'), chronicle.toJSONL(), 'utf8');
    writeFileSync(join(handle.dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    writeFileSync(join(handle.dir, 'world.json'), JSON.stringify(world, null, 2), 'utf8');
  }

  readMeta(runId: string): RunMeta {
    const path = join(this.dir(runId), 'meta.json');
    if (!existsSync(path)) throw new Error(`run "${runId}" has no meta.json at ${path}`);
    return JSON.parse(readFileSync(path, 'utf8')) as RunMeta;
  }

  readWorld(runId: string): Record<string, unknown> {
    const path = join(this.dir(runId), 'world.json');
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  }

  readTrace(runId: string): TraceEvent[] {
    const path = join(this.dir(runId), 'trace.jsonl');
    if (!existsSync(path)) return [];
    return Chronicle.parseJSONL(readFileSync(path, 'utf8'));
  }

  remove(runId: string): void {
    rmSync(this.dir(runId), { recursive: true, force: true });
  }
}
