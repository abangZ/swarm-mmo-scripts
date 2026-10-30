import './helpers/browser';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { nearestUnowned, validateLaunch } from '../src/features/manual/nearest';
import { findNearest, send } from '../src/game/manual';
import { getSession } from '../src/game/session';
import { subscribe } from '../src/game/subscriptions';
import { fixture, planet } from './helpers/fixtures';

test('distance excludes owned planets and source; bigint ID breaks ties', () => {
  const source = planet(1n, 0, 0, true), far = planet(2n, 4, 4);
  const near = planet(9007199254740994n, 5, 0), tie = planet(9007199254740993n, 0, 5);
  assert.equal(nearestUnowned(source, [source, planet(3n, 1, 0, true), far, near, tie]), tie);
  assert.equal(nearestUnowned(source, [source]), undefined);
});
test('launch validation rejects ownership changes and invalid inventory', () => {
  const source = planet(1n, 0, 0, true), target = planet(2n, 1, 0);
  for (const count of [0, -1, 1.5, 21, NaN, Infinity]) assert.throws(() => validateLaunch(source, target, 'me', count));
  assert.throws(() => validateLaunch(source, target, 'other', 1));
  assert.throws(() => validateLaunch(source, source, 'me', 1));
  assert.doesNotThrow(() => validateLaunch(source, target, 'me', 20));
});
test('search expands past square corners and releases subscriptions', async () => {
  const f = fixture([planet(1n, 0, 0, true), planet(2n, 15, 15)]);
  const result = await findNearest(getSession(), 1n);
  assert.equal(result.radius, 32); assert.equal(f.handles[0].isActive(), false);
  await send(result, 10);
  assert.equal(f.launchSwarm.mock.callCount(), 1);
  assert.deepEqual(f.launchSwarm.mock.calls[0].arguments, [{ sourcePlanetId: 1n, targetPlanetId: 2n, probeCount: 10 }]);
  result.release(); assert.equal(f.handles[1].isActive(), false);
});
test('changed target or connection blocks dispatch', async () => {
  const rows = [planet(1n, 0, 0, true), planet(2n, 10, 0)];
  const f = fixture(rows), result = await findNearest(f.session, 1n);
  rows.push(planet(3n, 1, 0));
  await assert.rejects(send(result, 10), /最近目标已变化/);
  f.session.conn.isActive = false;
  await assert.rejects(send(result, 10), /未连接游戏/);
  assert.equal(f.launchSwarm.mock.callCount(), 0); result.release();
});
test('search bound exhaustion releases all subscriptions without guessing', async () => {
  const f = fixture([planet(1n, 0, 0, true)]);
  await assert.rejects(findNearest(f.session, 1n), /未发送/);
  assert.equal(f.handles.length, 7); assert.ok(f.handles.every(h => !h.isActive()));
});
test('query timeout unsubscribes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture([]), unsubscribe = mock.fn();
  f.session.conn.subscriptionBuilder = () => {
    const builder = { onApplied: () => builder, onError: () => builder, subscribe: () => ({ unsubscribe, isActive: () => false }) };
    return builder;
  };
  const pending = assert.rejects(subscribe(f.session.conn, 'SELECT * FROM planet'), /超时/);
  t.mock.timers.tick(12000); await pending;
  assert.equal(unsubscribe.mock.callCount(), 1);
});
