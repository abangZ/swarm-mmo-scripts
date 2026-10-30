import './helpers/browser';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { AppController } from '../src/app/controller';
import { fakeWorld, settle } from './helpers/fixtures';
import { withControl, unresolved } from '../src/runtime/operations';

test('auto unmount during throttle does not dispatch, and releases the shared lock', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  localStorage.setItem('swarm-helper-last-operation-v1', '100000');
  const f = fakeWorld();
  const controller = new AppController(() => f.world);
  controller.start(); await settle();
  assert.equal(controller.getSnapshot().expansion.running, true);
  controller.dispose();
  t.mock.timers.tick(1500); await settle();
  assert.equal((f.world.launch as any).mock.callCount(), 0);
  assert.equal((f.world.dispose as any).mock.callCount(), 1);
  assert.equal(unresolved(), false);
  await withControl(async () => {});
});

test('stop then start during in-flight acknowledgement retains one engine and does not release the lock early', async () => {
  const f = fakeWorld();
  let acknowledge!: () => void;
  f.world.launch = mock.fn(() => new Promise<void>(resolve => { acknowledge = resolve; }));
  const create = mock.fn(() => f.world);
  const controller = new AppController(create);
  controller.start(); await settle();
  controller.stop(); controller.start();
  assert.equal(create.mock.callCount(), 1);
  assert.equal((f.world.launch as any).mock.callCount(), 1);
  await assert.rejects(withControl(async () => {}), /另一个标签页/);
  acknowledge(); await settle();
  assert.equal(controller.getSnapshot().expansion.running, false);
  assert.equal(controller.getSnapshot().uncertain, false);
  assert.equal((f.world.dispose as any).mock.callCount(), 1);
  await withControl(async () => {});
  controller.dispose();
});

test('a new panel cannot dispatch while the old disposed panel still owns a pending operation', async () => {
  const old = fakeWorld();
  let acknowledge!: () => void;
  old.world.launch = mock.fn(() => new Promise<void>(resolve => { acknowledge = resolve; }));
  const controller = new AppController(() => old.world);
  controller.start(); await settle();
  controller.dispose();
  const next = fakeWorld();
  const create = mock.fn(() => next.world);
  const replacement = new AppController(create);
  replacement.start(); await settle();
  assert.equal(create.mock.callCount(), 0);
  assert.equal((next.world.launch as any).mock.callCount(), 0);
  acknowledge(); await settle();
  assert.equal(unresolved(), false);
  await withControl(async () => {});
  replacement.dispose();
});
