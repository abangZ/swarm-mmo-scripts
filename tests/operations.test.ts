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
