import './helpers/browser';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, withControl, unresolved, unlockAfterReview } from '../src/runtime/operations';
import { settle } from './helpers/fixtures';

test('operation lock excludes concurrent tabs and throttle never catches up in a burst', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  let release!: () => void;
  const first = withControl(() => new Promise<void>(r => { release = r; }));
  await settle();
  await assert.rejects(withControl(async () => {}), /另一个标签页/);
  release(); await first;
  const work = mock.fn(async () => {});
  await withControl(() => dispatch(() => work, 1500, () => true));
  const second = withControl(() => dispatch(() => work, 1500, () => true));
  await settle(); assert.equal(work.mock.callCount(), 1);
  t.mock.timers.tick(1499); await settle(); assert.equal(work.mock.callCount(), 1);
  t.mock.timers.tick(1); await second; assert.equal(work.mock.callCount(), 2);
});
test('unknown outcomes survive restart and require explicit unlock; stale jobs do not lock', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  await withControl(() => dispatch(() => null, 1500, () => true));
  assert.equal(unresolved(), false);
  let resolve!: () => void;
  const pending = assert.rejects(withControl(() => dispatch(() => () => new Promise<void>(r => { resolve = r; }), 1500, () => true)), /结果未知/);
  await settle(); t.mock.timers.tick(15000); await pending;
  assert.equal(unresolved(), true);
  await assert.rejects(withControl(async () => {}), /上次发射结果未知/);
  await unlockAfterReview(); assert.equal(unresolved(), false);
  resolve(); await settle();
});

test('attack and expansion have separate persisted cooldowns and permit concurrent receipts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const times: Record<string, number[]> = { attack: [], expansion: [] };
  let acknowledge!: () => void;
  const expansion = dispatch(() => () => { times.expansion.push(Date.now()); return new Promise<void>(resolve => { acknowledge = resolve; }); }, 2000, () => true, 'expansion');
  await settle();
  assert.equal(unresolved(), false, 'a known pending receipt does not masquerade as an unknown result');
  const attack = () => dispatch(() => async () => { times.attack.push(Date.now()); }, 1000, () => true, 'attack');
  await attack();
  const next = attack(); t.mock.timers.tick(999); await settle(); assert.equal(times.attack.length, 1);
  t.mock.timers.tick(1); await next;
  assert.deepEqual(times.attack, [100000, 101000]);
  assert.ok(localStorage.getItem('swarm-helper-uncertain-v1'), 'attack acknowledgement preserves expansion token');
  await assert.rejects(dispatch(() => async () => {}, 2000, () => true, 'expansion'), /已有操作/);
  acknowledge(); await expansion;
  const again = dispatch(() => async () => { times.expansion.push(Date.now()); }, 2000, () => true, 'expansion');
  t.mock.timers.tick(1000); await again;
  assert.deepEqual(times.expansion, [100000, 102000]);
  assert.equal(localStorage.getItem('swarm-helper-uncertain-v1'), null);
});

test('a late receipt clears only its lane and cannot erase another lane failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  let acknowledge!: () => void;
  const expansion = dispatch(() => () => new Promise<void>(resolve => { acknowledge = resolve; }), 1500, () => true, 'expansion');
  await settle();
  await assert.rejects(dispatch(() => async () => { throw new Error('attack receipt lost'); }, 1000, () => true, 'attack'));
  acknowledge(); await expansion;
  assert.equal(unresolved(), true);
  const markers = JSON.parse(localStorage.getItem('swarm-helper-uncertain-v1')!);
  assert.deepEqual(Object.keys(markers), ['attack']);
  await assert.rejects(dispatch(() => async () => {}, 1500, () => true, 'expansion'), /结果未知/);
  await unlockAfterReview(); assert.equal(unresolved(), false);
});

test('throttle cancellation does not consume a lane interval or leave an unknown marker', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  localStorage.setItem('swarm-helper-last-attack-operation-v1', '100000');
  const controller = new AbortController(), work = mock.fn(async () => {});
  const task = dispatch(() => work, 1000, () => true, 'attack', controller.signal);
  controller.abort(); await task;
  assert.equal(work.mock.callCount(), 0);
  assert.equal(localStorage.getItem('swarm-helper-last-attack-operation-v1'), '100000');
  assert.equal(localStorage.getItem('swarm-helper-uncertain-v1'), null);
});

test('persisted tokens from a reload or the legacy script block both lanes until review', async () => {
  for (const marker of ['old-request', JSON.stringify({ attack: 'before-reload-a', expansion: 'before-reload-e' })]) {
    localStorage.setItem('swarm-helper-uncertain-v1', marker);
    for (const mode of ['attack', 'expansion'] as const) await assert.rejects(dispatch(() => async () => {}, 1000, () => true, mode), /结果未知/);
    await unlockAfterReview(); assert.equal(unresolved(), false);
  }
});

test('lane throttling starts at the actual launch, including synchronous adapter work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const times: number[] = [];
  const first = dispatch(() => async () => {
    t.mock.timers.tick(8); // UI / adapter work before the native request.
    times.push(Date.now());
  }, 1000, () => true, 'attack');
  assert.deepEqual(times, [100008], 'launch must not wait behind another lane planning microtask');
  await first;
  const next = dispatch(() => async () => { times.push(Date.now()); }, 1000, () => true, 'attack');
  t.mock.timers.tick(999); await settle(); assert.equal(times.length, 1);
  t.mock.timers.tick(1); await next;
  assert.deepEqual(times, [100008, 101008]);
});
