import './helpers/browser';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { defaults, members, totalCount } from '../src/features/expansion/types';
import { ExpansionEngine } from '../src/features/expansion/engine';
import { unresolved, withControl } from '../src/runtime/operations';
import { fakeWorld, coalitionWorld, identity, planet, settle } from './helpers/fixtures';
import { safeQuote } from '../src/game/expansion-world';

test('one source captures garrisons 4 and 1 with five and two probes without waiting for a full scan', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fakeWorld(); f.target.probeCount = 4;
  const second = planet(3n, 2, 1); second.probeCount = 1; f.snapshot.planets.push(second);
  f.snapshot.budgets.set(1n, 7);
  f.world.quote = (_source, id) => safeQuote({ travelMs: id === 2n ? 1000 : 2000, lossPct: 0, outOfRange: false, exact: { reason: 'capture', probes: f.snapshot.planets.find(p => p.planetId === id)!.probeCount + 1 } });
  f.world.launch = mock.fn(async (source, _target, count) => { f.snapshot.budgets.set(source, f.snapshot.budgets.get(source)! - count); });
  f.world.syncInventory = mock.fn(async () => {});
  const engine = new ExpansionEngine(() => {}, () => f.world);
  const run = engine.start({ ...defaults, scanMs: 120000 }); await settle();
  t.mock.timers.tick(1500); await settle();
  const calls = (f.world.launch as any).mock.calls.map((c: any) => c.arguments);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c: any[]) => [c[1], c[2]]).sort(), [[2n, 5], [3n, 2]]);
  assert.equal(f.snapshot.budgets.get(1n), 0);
  assert.equal((f.world.scan as any).mock.callCount(), 1);
  assert.equal((f.world.syncInventory as any).mock.callCount(), 2);
  engine.stop(); t.mock.timers.tick(500); await run;
});

test('a neutral garrison of one uses a single affordable source instead of two one-probe fleets', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = coalitionWorld(); f.target.probeCount = 1;
  f.snapshot.budgets.set(1n, 1); f.snapshot.budgets.set(4n, 2);
  f.world.quote = source => f.snapshot.budgets.get(source)! >= 2 ? { count: 2, travelMs: 10000 } : null;
  const engine = new ExpansionEngine(() => {}, () => f.world);
  const run = engine.start(defaults); await settle();
  assert.deepEqual((f.world.launch as any).mock.calls[0].arguments, [4n, 2n, 2]);
  assert.equal((f.world.launchGroup as any).mock.callCount(), 0);
  engine.stop(); t.mock.timers.tick(500); await run;
});

test('a queued coalition keeps its planned allocation without re-quoting after production', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  localStorage.setItem('swarm-helper-last-operation-v1', '100000');
  const f = coalitionWorld(); f.target.probeCount = 4;
  f.snapshot.budgets.set(1n, 3); f.snapshot.budgets.set(4n, 3);
  f.world.quote = source => f.snapshot.budgets.get(source)! >= 5 ? { count: 5, travelMs: 10000 } : null;
  const engine = new ExpansionEngine(() => {}, () => f.world);
  const run = engine.start(defaults); await settle();
  assert.equal(members(engine.state.queue[0]).length, 2);
  const planned = structuredClone(engine.state.queue[0]);
  assert.equal(totalCount(planned), 5);
  f.snapshot.budgets.set(1n, 6); t.mock.timers.tick(1500); await settle();
  assert.equal((f.world.launch as any).mock.callCount(), 0);
  assert.deepEqual((f.world.launchGroup as any).mock.calls[0].arguments, [planned]);
  engine.stop(); t.mock.timers.tick(500); await run;
});

test('stopping while confirmed inventory is synchronizing cancels subsequent sends without marking launch unknown', async () => {
  const f = fakeWorld(); let sync!: () => void;
  f.world.syncInventory = () => new Promise<void>(resolve => { sync = resolve; });
  const engine = new ExpansionEngine(() => {}, () => f.world);
  const run = engine.start(defaults); await settle();
  engine.stop(); sync(); await run;
  assert.equal((f.world.launch as any).mock.callCount(), 1);
  assert.equal(engine.state.activity, 'stopped'); assert.equal(unresolved(), false);
  assert.equal((f.world.dispose as any).mock.callCount(), 1);
});

test('inventory sync failure keeps expansion active, without retrying the launch or creating an unknown marker', async () => {
  const f = fakeWorld(); f.world.syncInventory = async () => { throw new Error('库存同步失败'); };
  const engine = new ExpansionEngine(() => {}, () => f.world); const run = engine.start(defaults); await settle();
  assert.equal((f.world.launch as any).mock.callCount(), 1);
  assert.equal(engine.running, true); assert.match(engine.state.phase, /库存同步暂不可用/);
  assert.equal(unresolved(), false);
  engine.stop(); await run;
});

test('engine uses the planned quote, adds reservations and locks in-flight targets', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fakeWorld(); let quoted = 0;
  f.world.quote = () => ({ count: ++quoted === 1 ? 10 : 12, travelMs: 1000 });
  const engine = new ExpansionEngine(() => {}, () => f.world);
  const run = engine.start(defaults); await settle();
  assert.deepEqual((f.world.launch as any).mock.calls[0].arguments, [1n, 2n, 10]);
  t.mock.timers.tick(1500); await settle();
  assert.equal((f.world.launch as any).mock.callCount(), 1);
  f.target.ownerId = identity; f.snapshot.owned.push(f.target);
  t.mock.timers.tick(10000); await settle();
  assert.equal(engine.state.captured, 1);
  engine.stop(); t.mock.timers.tick(500); await run;
  assert.equal((f.world.dispose as any).mock.callCount(), 1);
});
test('engine adopts manual fleets and never sends when the safe quote exceeds budget', async t => {
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
test('expansion does not request a new quote while dequeuing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fakeWorld(); let quotes = 0;
  f.world.quote = () => { assert.equal(++quotes, 1); return { count: 12, travelMs: 1000 }; };
  const engine = new ExpansionEngine(() => {}, () => f.world);
  const run = engine.start(defaults); await settle();
  assert.deepEqual((f.world.launch as any).mock.calls[0].arguments, [1n, 2n, 12]);
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
test('connection failures schedule automatic recovery and an explicit stop releases ownership', async () => {
  const f = fakeWorld();
  f.world.read = () => { throw new Error('连接已变化'); };
  const engine = new ExpansionEngine(() => {}, () => f.world);
  const run = engine.start(defaults); await settle();
  assert.equal(engine.running, true);
  assert.match(engine.state.phase, /连接已变化/);
  assert.equal((f.world.launch as any).mock.callCount(), 0);
  engine.stop(); await run; await withControl(async () => {});
});


test('engine submits a whole triple in one operation and tracks capture once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = coalitionWorld(3);
  const engine = new ExpansionEngine(() => {}, () => f.world);
  const run = engine.start(defaults); await settle();
  assert.equal((f.world.launchGroup as any).mock.callCount(), 1);
  const job = (f.world.launchGroup as any).mock.calls[0].arguments[0];
  assert.equal(members(job).length, 3); assert.equal(totalCount(job), 11);
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
  for (const settings of [{ ...defaults, reserve: 3 }, { ...defaults, maxSources: 1 }]) {
    const f = coalitionWorld();
    const engine = new ExpansionEngine(() => {}, () => f.world);
    const run = engine.start(settings); await settle();
    assert.equal((f.world.launchGroup as any).mock.callCount(), 0);
    engine.stop(); t.mock.timers.tick(500); await run;
  }
});
test('failed expansion bulk requests are skipped without locking or retrying individual members', async () => {
  const f = coalitionWorld();
  f.world.launchGroup = mock.fn(async () => { throw new Error('bulk rejected'); });
  const engine = new ExpansionEngine(() => {}, () => f.world);
  const run = engine.start(defaults); await settle();
  assert.equal((f.world.launchGroup as any).mock.callCount(), 1);
  assert.equal((f.world.launch as any).mock.callCount(), 0);
  assert.equal(unresolved(), false); assert.equal(engine.running, true);
  engine.stop(); await run;
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
  assert.deepEqual((f.world.launch as any).mock.calls[0].arguments, [1n, 3n, 5]);
  t.mock.timers.tick(1500); await settle();
  const job = (f.world.launchGroup as any).mock.calls[0].arguments[0];
  assert.ok(members(job).find(m => m.sourceId === 1n)!.count <= 5);
  assert.equal(totalCount(job), 11);
  engine.stop(); t.mock.timers.tick(500); await run;
});

test('cancelled scan and a late rejected expansion request remain stopped without locking', async () => {
  const f = fakeWorld(); let rejectScan!: (error: Error) => void;
  f.world.scan = () => new Promise<void>((_resolve, reject) => { rejectScan = reject; });
  const engine = new ExpansionEngine(() => {}, () => f.world);
  const run = engine.start(defaults); await settle();
  engine.stop(); rejectScan(new Error('扫描已停止。')); await run;
  assert.equal(engine.state.activity, 'stopped');
  assert.equal(engine.state.nextScanAt, null);
  assert.equal((f.world.launch as any).mock.callCount(), 0);
  const next = fakeWorld(); let rejectLaunch!: (error: Error) => void;
  next.world.launch = () => new Promise<void>((_resolve, reject) => { rejectLaunch = reject; });
  const pending = new ExpansionEngine(() => {}, () => next.world);
  const request = pending.start(defaults); await settle();
  pending.stop(); rejectLaunch(new Error('发射失败')); await request;
  assert.equal(pending.state.activity, 'stopped');
  assert.equal(unresolved(), false);
});
