import './helpers/browser';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { defaults, members, totalCount } from '../src/features/expansion/types';
import { ExpansionEngine } from '../src/features/expansion/engine';
import { unresolved, withControl } from '../src/runtime/operations';
import { fakeWorld, coalitionWorld, identity, planet, settle } from './helpers/fixtures';

test('engine re-quotes before dispatch, adds reservations and locks in-flight targets', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fakeWorld(); let quoted = 0;
  f.world.quote = () => ({ count: ++quoted === 1 ? 10 : 12, travelMs: 1000 });
  const engine = new ExpansionEngine(() => {}, () => f.world);
  const run = engine.start(defaults); await settle();
  assert.deepEqual((f.world.launch as any).mock.calls[0].arguments, [1n, 2n, 12]);
  t.mock.timers.tick(1500); await settle();
  assert.equal((f.world.launch as any).mock.callCount(), 1);
  f.target.ownerId = identity; f.snapshot.owned.push(f.target);
  t.mock.timers.tick(10000); await settle();
  assert.equal(engine.state.captured, 1);
  engine.stop(); t.mock.timers.tick(500); await run;
  assert.equal((f.world.dispose as any).mock.callCount(), 1);
});
test('engine adopts manual fleets and never sends when quote plus two exceeds budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fakeWorld(); f.snapshot.incoming.add(2n);
  const engine = new ExpansionEngine(() => {}, () => f.world);
  const run = engine.start(defaults); await settle();
  assert.equal((f.world.launch as any).mock.callCount(), 0);
  f.snapshot.incoming.clear(); f.snapshot.budgets.set(1n, 11);
  t.mock.timers.tick(1000); await settle();
  assert.equal((f.world.launch as any).mock.callCount(), 0);
  engine.stop(); t.mock.timers.tick(500); await run;
});
test('stop during scan cancels dispatch and disposes subscriptions', async () => {
  const f = fakeWorld(); let finish!: () => void;
  f.world.scan = () => new Promise<void>(r => { finish = r; });
  const engine = new ExpansionEngine(() => {}, () => f.world);
  const run = engine.start(defaults); await settle();
  engine.stop(); finish(); await run;
  assert.equal((f.world.launch as any).mock.callCount(), 0);
  assert.equal((f.world.dispose as any).mock.callCount(), 1);
});
test('a more expensive execution quote is skipped without marking a request uncertain', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fakeWorld(); let quotes = 0;
  f.world.quote = () => ({ count: ++quotes === 1 ? 12 : 21, travelMs: 1000 });
  const engine = new ExpansionEngine(() => {}, () => f.world);
  const run = engine.start(defaults); await settle();
  assert.equal((f.world.launch as any).mock.callCount(), 0);
  assert.equal(unresolved(), false);
  engine.stop(); t.mock.timers.tick(500); await run;
});
test('stopping during the rate-limit wait cannot leak a queued dispatch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  localStorage.setItem('swarm-helper-last-operation-v1', '100000');
  const f = fakeWorld();
  const engine = new ExpansionEngine(() => {}, () => f.world);
  const run = engine.start(defaults); await settle();
  engine.stop(); t.mock.timers.tick(1500); await run;
  assert.equal((f.world.launch as any).mock.callCount(), 0);
  assert.equal(unresolved(), false);
});
test('connection failures stop the engine and release ownership', async () => {
  const f = fakeWorld();
  f.world.read = () => { throw new Error('连接已变化'); };
  const engine = new ExpansionEngine(() => {}, () => f.world);
  await engine.start(defaults);
  assert.equal(engine.running, false);
  assert.match(engine.state.phase, /连接已变化/);
  assert.equal((f.world.launch as any).mock.callCount(), 0);
  await withControl(async () => {});
});


test('engine submits a whole triple in one operation and tracks capture once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = coalitionWorld(3);
  const engine = new ExpansionEngine(() => {}, () => f.world);
  const run = engine.start(defaults); await settle();
  assert.equal((f.world.launchGroup as any).mock.callCount(), 1);
  const job = (f.world.launchGroup as any).mock.calls[0].arguments[0];
  assert.equal(members(job).length, 3); assert.equal(totalCount(job), 13);
  assert.equal((f.world.launch as any).mock.callCount(), 0);
  assert.equal(engine.state.sent, 3); assert.equal(engine.state.flights, 1);
  f.snapshot.incoming.add(2n);
  t.mock.timers.tick(10000); await settle();
  assert.equal((f.world.launchGroup as any).mock.callCount(), 1);
  f.target.ownerId = identity; f.snapshot.owned.push(f.target); f.snapshot.incoming.clear();
  t.mock.timers.tick(10000); await settle(); assert.equal(engine.state.captured, 1);
  engine.stop(); t.mock.timers.tick(500); await run;
});
test('group dispatch is cancelled when any contributor loses its budget during the wait', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  localStorage.setItem('swarm-helper-last-operation-v1', '100000');
  const f = coalitionWorld();
  const engine = new ExpansionEngine(() => {}, () => f.world);
  const run = engine.start(defaults); await settle();
  f.snapshot.budgets.set(1n, 0);
  t.mock.timers.tick(1500); await settle();
  assert.equal((f.world.launchGroup as any).mock.callCount(), 0);
  assert.equal(unresolved(), false);
  engine.stop(); t.mock.timers.tick(500); await run;
});
test('reserve and single-source mode both prevent an underfunded coalition', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  for (const settings of [{ ...defaults, reserve: 2 }, { ...defaults, maxSources: 1 }]) {
    const f = coalitionWorld();
    const engine = new ExpansionEngine(() => {}, () => f.world);
    const run = engine.start(settings); await settle();
    assert.equal((f.world.launchGroup as any).mock.callCount(), 0);
    engine.stop(); t.mock.timers.tick(500); await run;
  }
});
test('failed bulk requests stop without retrying individual members', async () => {
  const f = coalitionWorld();
  f.world.launchGroup = mock.fn(async () => { throw new Error('bulk rejected'); });
  const engine = new ExpansionEngine(() => {}, () => f.world);
  await engine.start(defaults);
  assert.equal((f.world.launchGroup as any).mock.callCount(), 1);
  assert.equal((f.world.launch as any).mock.callCount(), 0);
  assert.equal(unresolved(), true); assert.equal(engine.running, false);
});

test('execution preserves the optimized split that leaves troops for another target', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = coalitionWorld();
  const extraTarget = planet(3n, 2, 0); extraTarget.probeCount = 2; f.snapshot.planets.push(extraTarget);
  f.snapshot.budgets.set(1n, 10); f.snapshot.budgets.set(4n, 8);
  f.world.quote = (source, target) => source === 1n && target === 3n ? { count: 5, travelMs: 5000 } : null;
  f.world.route = (_source, target) => target === 2n ? { travelMs: 10000, lossPct: 0 } : null;
  const engine = new ExpansionEngine(() => {}, () => f.world);
  const run = engine.start(defaults); await settle();
  const job = (f.world.launchGroup as any).mock.calls[0].arguments[0];
  assert.equal(members(job).find(m => m.sourceId === 1n)!.count, 5);
  assert.equal(members(job).find(m => m.sourceId === 4n)!.count, 8);
  t.mock.timers.tick(1500); await settle();
  assert.deepEqual((f.world.launch as any).mock.calls[0].arguments, [1n, 3n, 5]);
  engine.stop(); t.mock.timers.tick(500); await run;
});
