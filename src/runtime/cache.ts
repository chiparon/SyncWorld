/**
 * Content-addressed call cache.
 *
 * Key = sha256(model | params | messages | expect-contract).
 *
 * This is what makes replay/diff cheap *and* honest. Replaying a run after
 * swapping one node's model re-executes only that node; every untouched node
 * is served byte-identically from cache, so a diff shows the change you made
 * and nothing else. Without this, "compare two bindings" is noise.
 *
 * M3 extends the same keyspace into an eval store, so cached calls double as
 * a growing regression corpus.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { CompletionRequest, CompletionResponse } from '../schema/types.ts';

export function hashCall(req: CompletionRequest): string {
  const canonical = JSON.stringify({
    model: req.model,
    messages: req.messages,
    maxOut: req.maxOut ?? null,
    temperature: req.temperature ?? null,
    expect: req.expect ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function hashObject(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

export interface CacheStats {
  hits: number;
  misses: number;
  writes: number;
}

export class CallCache {
  private readonly dir: string;
  private readonly enabled: boolean;
  private readonly hitsByNode = new Map<string, number>();
  private stats: CacheStats = { hits: 0, misses: 0, writes: 0 };

  constructor(dir: string, enabled = true) {
    this.dir = dir;
    this.enabled = enabled;
    if (enabled) mkdirSync(dir, { recursive: true });
  }

  static open(projectRoot: string, enabled = true): CallCache {
    return new CallCache(resolve(projectRoot, '.syncw', 'cache'), enabled);
  }

  get(key: string, nodeId?: string): CompletionResponse | undefined {
    if (!this.enabled) return undefined;
    const path = join(this.dir, `${key}.json`);
    if (!existsSync(path)) {
      this.stats.misses++;
      return undefined;
    }
    this.stats.hits++;
    if (nodeId) this.hitsByNode.set(nodeId, (this.hitsByNode.get(nodeId) ?? 0) + 1);
    const raw = JSON.parse(readFileSync(path, 'utf8')) as CompletionResponse;
    return { ...raw, cached: true };
  }

  set(key: string, response: CompletionResponse): void {
    if (!this.enabled) return;
    this.stats.writes++;
    const { cached: _ignored, ...persisted } = response;
    writeFileSync(join(this.dir, `${key}.json`), JSON.stringify(persisted, null, 2), 'utf8');
  }

  hitsFor(nodeId: string): number {
    return this.hitsByNode.get(nodeId) ?? 0;
  }

  getStats(): CacheStats {
    return { ...this.stats };
  }

  size(): number {
    if (!existsSync(this.dir)) return 0;
    return readdirSync(this.dir).filter((f) => f.endsWith('.json')).length;
  }

  clear(): void {
    if (!existsSync(this.dir)) return;
    for (const f of readdirSync(this.dir)) {
      if (f.endsWith('.json')) rmSync(join(this.dir, f), { force: true });
    }
    this.stats = { hits: 0, misses: 0, writes: 0 };
    this.hitsByNode.clear();
  }
}
