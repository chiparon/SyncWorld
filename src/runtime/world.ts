/**
 * The World - Syncw's shared, typed, merge-aware blackboard.
 *
 * Every framework passes messages along edges. Almost none of them have a
 * first-class shared state. That gap is exactly where "multi-agent" systems
 * break: concurrent writers clobber each other, context gets re-summarised
 * lossily at every hop, and there is no way to rewind to a clean point.
 *
 * Making merge semantics *declared and enforced* is what turns the project
 * name into a technical claim:
 *   - concurrent fan-out is correct by construction
 *   - resume/partial-recompute becomes trivial
 *   - every write is attributable to a node
 */

import type { MergeStrategy, WorldField } from '../schema/types.ts';

export interface WorldWriteRecord {
  field: string;
  writer: string;
  strategy: MergeStrategy;
  before: unknown;
  after: unknown;
  ts: string;
  /** Set when a strategy had to resolve a genuine conflict. */
  conflict?: string;
}

export class WorldOwnershipError extends Error {
  readonly field: string;
  readonly writer: string;
  readonly owner: string;

  constructor(field: string, writer: string, owner: string) {
    super(
      `node "${writer}" attempted to write world field "${field}", owned by "${owner}". ` +
        `Declared ownership is enforced so concurrent agents cannot silently corrupt state.`,
    );
    this.name = 'WorldOwnershipError';
    this.field = field;
    this.writer = writer;
    this.owner = owner;
  }
}

export class World {
  readonly schema: Record<string, WorldField>;

  private values: Record<string, unknown> = {};
  /** field -> set of writers that have written in this run. */
  private writers = new Map<string, Set<string>>();
  private log: WorldWriteRecord[] = [];

  constructor(schema: Record<string, WorldField>) {
    this.schema = schema;
  }

  /** Seed a field outside of node execution (run inputs, replay restores). */
  seed(field: string, value: unknown): void {
    this.values[field] = value;
  }

  get(field: string): unknown {
    return this.values[field];
  }

  has(field: string): boolean {
    return this.values[field] !== undefined && this.values[field] !== null;
  }

  snapshot(): Record<string, unknown> {
    return structuredClone(this.values);
  }

  writes(): readonly WorldWriteRecord[] {
    return this.log;
  }

  /** Field names declared in this workflow's schema. */
  fieldNames(): string[] {
    return Object.keys(this.schema);
  }

  /**
   * Apply a write using the field's declared merge strategy.
   * Throws if the writer is not the declared owner.
   */
  write(field: string, value: unknown, writer: string): WorldWriteRecord {
    const spec = this.schema[field];
    if (!spec) {
      throw new Error(
        `world field "${field}" is not declared in the workflow schema. ` +
          `Declare it under \`world:\` so its merge semantics are explicit.`,
      );
    }
    if (spec.owner && spec.owner !== writer) {
      throw new WorldOwnershipError(field, writer, spec.owner);
    }

    const before = this.values[field];
    const seen = this.writers.get(field) ?? new Set<string>();
    const priorOtherWriter = [...seen].find((w) => w !== writer);
    seen.add(writer);
    this.writers.set(field, seen);

    let conflict: string | undefined;
    let after: unknown;

    switch (spec.merge) {
      case 'append': {
        after = concat(before, value);
        break;
      }
      case 'sum': {
        after = num(before, 0) + num(value, 0);
        break;
      }
      case 'max': {
        after = before === undefined || before === null ? value : Math.max(num(before, 0), num(value, 0));
        break;
      }
      case 'first_write_wins': {
        if (before === undefined || before === null) {
          after = value;
        } else {
          after = before;
          conflict = 'first_write_wins kept the earlier value';
        }
        break;
      }
      case 'last_write_wins': {
        after = value;
        if (priorOtherWriter) conflict = `last_write_wins overwrote a value from "${priorOtherWriter}"`;
        break;
      }
      case 'replace':
      default: {
        after = value;
        if (priorOtherWriter) {
          // `replace` is the "I believe I am the only writer" strategy. Surfacing
          // this as a conflict is the point: it catches accidental double-writes.
          conflict = `replace overwrote a value from "${priorOtherWriter}" - if this is intended, use last_write_wins`;
        }
        break;
      }
    }

    this.values[field] = after;
    const record: WorldWriteRecord = {
      field,
      writer,
      strategy: spec.merge,
      before,
      after,
      ts: new Date().toISOString(),
    };
    if (conflict) record.conflict = conflict;
    this.log.push(record);
    return record;
  }
}

function concat(before: unknown, value: unknown): unknown {
  const base = before === undefined || before === null ? [] : Array.isArray(before) ? before : [before];
  const add = Array.isArray(value) ? value : [value];
  return [...base, ...add];
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
