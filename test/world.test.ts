/**
 * World state: merge semantics, ownership, and conflict detection.
 *
 * These are the properties that make "Synchronized World" a technical claim
 * rather than a name, so they get tested directly rather than through a
 * workflow that happens to exercise them.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { World, WorldOwnershipError } from '../src/runtime/world.ts';
import type { WorldField } from '../src/schema/types.ts';

const SCHEMA: Record<string, WorldField> = {
  plan: { type: 'json', merge: 'replace', owner: 'planner' },
  // No owner: two different nodes are allowed to write here, which is the only
  // way to observe a `replace` conflict.
  shared: { type: 'json', merge: 'replace' },
  findings: { type: 'json', merge: 'append' },
  total: { type: 'number', merge: 'sum' },
  best: { type: 'number', merge: 'max' },
  first: { type: 'string', merge: 'first_write_wins' },
  loose: { type: 'json', merge: 'last_write_wins' },
};

function world(): World {
  return new World(SCHEMA);
}

describe('merge strategies', () => {
  test('append flattens exactly one level', () => {
    const w = world();
    w.write('findings', [{ id: 1 }, { id: 2 }], 'researcher');
    w.write('findings', [{ id: 3 }], 'researcher');
    w.write('findings', [{ id: 4 }, { id: 5 }], 'researcher');

    assert.deepEqual(w.get('findings'), [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]);
  });

  test('append wraps a scalar instead of spreading it', () => {
    const w = world();
    w.write('findings', 'a', 'researcher');
    w.write('findings', ['b', 'c'], 'researcher');
    assert.deepEqual(w.get('findings'), ['a', 'b', 'c']);
  });

  test('sum accumulates and max keeps the largest', () => {
    const w = world();
    w.write('total', 3, 'a');
    w.write('total', 4, 'a');
    assert.equal(w.get('total'), 7);

    w.write('best', 5, 'a');
    w.write('best', 2, 'a');
    w.write('best', 9, 'a');
    assert.equal(w.get('best'), 9);
  });

  test('first_write_wins keeps the earliest value and reports the conflict', () => {
    const w = world();
    w.write('first', 'kept', 'a');
    const record = w.write('first', 'discarded', 'b');

    assert.equal(w.get('first'), 'kept');
    assert.match(record.conflict ?? '', /first_write_wins kept the earlier value/);
  });
});

describe('conflict detection', () => {
  test('replace by a single writer records no conflict', () => {
    const w = world();
    w.write('plan', { steps: 1 }, 'planner');
    const record = w.write('plan', { steps: 2 }, 'planner');
    assert.equal(record.conflict, undefined);
    assert.deepEqual(w.get('plan'), { steps: 2 });
  });

  test('replace by a second writer flags the accidental double-write', () => {
    const w = world();
    w.write('shared', { by: 'a' }, 'node-a');
    // `replace` means "I believe I am the only writer". Breaking that belief is
    // exactly what the conflict field exists to surface.
    const record = w.write('shared', { by: 'b' }, 'node-b');
    assert.match(record.conflict ?? '', /overwrote a value from "node-a"/);
    assert.match(record.conflict ?? '', /use last_write_wins/);
    assert.deepEqual(w.get('shared'), { by: 'b' });
  });

  test('last_write_wins overwrites and still reports who was overwritten', () => {
    const w = world();
    w.write('loose', 'old', 'a');
    const record = w.write('loose', 'new', 'b');
    assert.equal(w.get('loose'), 'new');
    assert.match(record.conflict ?? '', /last_write_wins overwrote a value from "a"/);
  });

  test('the write log records before and after for every write', () => {
    const w = world();
    w.write('loose', 'one', 'a');
    w.write('loose', 'two', 'b');
    const writes = w.writes();
    assert.equal(writes.length, 2);
    assert.equal(writes[1]!.before, 'one');
    assert.equal(writes[1]!.after, 'two');
    assert.equal(writes[1]!.writer, 'b');
  });
});

describe('ownership is enforced, not documented', () => {
  test('a non-owner write throws rather than silently clobbering', () => {
    const w = world();
    assert.throws(
      () => w.write('plan', { steps: 1 }, 'impostor'),
      (err: unknown) => {
        assert.ok(err instanceof WorldOwnershipError);
        assert.equal(err.field, 'plan');
        assert.equal(err.owner, 'planner');
        assert.equal(err.writer, 'impostor');
        return true;
      },
    );
    assert.equal(w.get('plan'), undefined);
  });

  test('writing an undeclared field throws with a fixable message', () => {
    const w = world();
    assert.throws(() => w.write('nope', 1, 'a'), /is not declared in the workflow schema/);
  });
});

describe('snapshots', () => {
  test('snapshot is a deep copy, so callers cannot mutate live state', () => {
    const w = world();
    w.write('plan', { steps: [{ id: 's1' }] }, 'planner');
    const snap = w.snapshot() as { plan: { steps: Array<{ id: string }> } };
    snap.plan.steps.push({ id: 'injected' });
    assert.equal((w.get('plan') as { steps: unknown[] }).steps.length, 1);
  });
});
