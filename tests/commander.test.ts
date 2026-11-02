import './helpers/browser';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Commander } from '../src/features/commander/engine';
import { defaults } from '../src/features/expansion/types';
import { defaultPolicy, type ModeConfig } from '../src/features/commander/types';
import { fakeWorld, planet, settle } from './helpers/fixtures';
import { unresolved, withControl } from '../src/runtime/operations';
import { planAttack } from '../src/features/attack/planner';
import { reserveFor } from '../src/features/commander/safety';

const enemy = 'a'.repeat(64);
const config = (x = 0): ModeConfig => ({ settings: { ...defaults, maxSources: 1 }, policy: { ...defaultPolicy, zone: { x, y: 0, radius: 10 }, frontlinePercent: 0 } });
function fixture(separate = true) {
  const f = fakeWorld(); f.source.level = 10; f.target.level = 1;
  f.snapshot.identity = 'me'; f.snapshot.allies = new Set(['me']); f.snapshot.intelligence = true; f.snapshot.fleets = []; f.snapshot.automated = new Set();
  const hostile = planet(9n, separate ? 101 : 2, 0); hostile.level = 1; hostile.ownerId = { toHexString: () => enemy };
  f.snapshot.planets.push(hostile); f.snapshot.budgets.set(1n, 100);
  if (separate) { const source = planet(8n, 100, 0, true); source.level = 10; f.snapshot.owned.push(source); f.snapshot.planets.push(source); f.snapshot.budgets.set(8n, 100); }
  f.world.route = () => ({ travelMs: 1000, lossPct: 0 });
  const launches: { source: bigint; target: bigint; count: number; time: number }[] = [];
  f.world.launch = mock.fn(async (source, target, count) => { launches.push({ source, target, count, time: Date.now() }); });
  const create = mock.fn(() => f.world);
  const commander = new Commander(() => {}, create);
  return { ...f, hostile, launches, commander, create };
}

test('separate regions run together through one executor, alternate ready work and stop independently', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fixture(); const second = planet(3n, 2, 0); f.snapshot.planets.push(second);
  const run = f.commander.start('expansion', config());
  f.commander.start('attack', config(100));
  await settle(); t.mock.timers.tick(250); await settle();
  assert.equal(f.create.mock.callCount(), 1);
  assert.deepEqual(f.launches.map(l => [l.source, l.target]), [[1n, 2n]]);
  t.mock.timers.tick(1500); await settle();
  assert.deepEqual(f.launches.map(l => [l.source, l.target]), [[1n, 2n], [8n, 9n]]);
  assert.ok(f.launches[1].time - f.launches[0].time >= 1500);
  f.commander.stop('attack'); t.mock.timers.tick(1500); await settle();
  assert.equal(f.commander.states.attack.running, false);
  assert.equal(f.commander.states.expansion.running, true);
  assert.equal(f.launches[2].target, 3n);
  assert.equal((f.world.dispose as any).mock.callCount(), 0);
  f.commander.stop(); t.mock.timers.tick(500); await run;
  assert.equal((f.world.dispose as any).mock.callCount(), 1);
  await withControl(async () => {});
});

test('overlapping regions reserve the next attack and never spend the same inventory twice', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fixture(false); f.snapshot.budgets.set(1n, 28);
  const run = f.commander.start('expansion', config()); f.commander.start('attack', config());
  await settle(); t.mock.timers.tick(250); await settle();
  assert.equal(f.launches.length, 1); assert.equal(f.launches[0].target, 9n); assert.equal(f.launches[0].count, 24);
  t.mock.timers.tick(1500); await settle();
  assert.equal(f.launches.length, 1);
  f.commander.stop(); t.mock.timers.tick(500); await run;
});

test('short attack saving blocks competing expansion, and stopping attack releases its unused reservation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fixture(false); f.snapshot.budgets.set(1n, 20);
  const run = f.commander.start('expansion', config()); f.commander.start('attack', config());
  await settle(); t.mock.timers.tick(250); await settle();
  assert.equal(f.launches.length, 0); assert.match(f.commander.states.attack.phase, /攒兵/);
  f.commander.stop('attack'); t.mock.timers.tick(500); await settle();
  assert.equal(f.launches.length, 1); assert.equal(f.launches[0].target, 2n);
  assert.equal(f.commander.states.attack.running, false);
  f.commander.stop(); t.mock.timers.tick(500); await run;
});

test('saving expires instead of starving expansion forever', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fixture(false); f.snapshot.budgets.set(1n, 20);
  const run = f.commander.start('expansion', config()); f.commander.start('attack', config());
  await settle(); t.mock.timers.tick(250); await settle();
  t.mock.timers.tick(120001); await settle();
  assert.equal(f.launches.length, 1); assert.equal(f.launches[0].target, 2n);
  f.commander.stop(); t.mock.timers.tick(500); await run;
});

test('alliance changes and new incoming fleets cancel queued attacks before transmission', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  for (const change of ['ally', 'fleet', 'inventory']) {
    const f = fixture(false);
    localStorage.setItem('swarm-helper-last-operation-v1', String(Date.now()));
    const run = f.commander.start('attack', config()); await settle();
    if (change === 'ally') f.snapshot.allies!.add(enemy);
    if (change === 'fleet') f.snapshot.fleets!.push({ id: 33n, owner: enemy, target: 9n, count: 50, arrival: 200000, arriving: 50 });
    if (change === 'inventory') f.snapshot.budgets.set(1n, 1);
    t.mock.timers.tick(1500); await settle();
    assert.equal(f.launches.length, 0); assert.equal(unresolved(), false);
    f.commander.stop(); t.mock.timers.tick(500); await run;
  }
});

test('an uncertain launch stops both modes without executing the other queue', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fixture(); f.world.launch = mock.fn(async () => { throw new Error('unknown acknowledgement'); });
  const run = f.commander.start('expansion', config()); f.commander.start('attack', config(100));
  await settle(); t.mock.timers.tick(250); await run;
  assert.equal((f.world.launch as any).mock.callCount(), 1);
  assert.equal(f.commander.states.expansion.activity, 'error'); assert.equal(f.commander.states.attack.activity, 'error');
  assert.equal(f.commander.states.expansion.running, false); assert.equal(f.commander.states.attack.running, false);
  assert.equal(unresolved(), true); assert.equal((f.world.dispose as any).mock.callCount(), 1);
});

test('adding a mode during a throttle invalidates the prepared task until joint intelligence is scanned', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  localStorage.setItem('swarm-helper-last-operation-v1', '100000');
  const f = fixture();
  const run = f.commander.start('expansion', config()); await settle();
  f.commander.start('attack', config(100)); t.mock.timers.tick(1500); await settle();
  assert.equal(f.launches.length, 0);
  t.mock.timers.tick(1500); await settle();
  assert.ok((f.world.scan as any).mock.callCount() >= 2); assert.equal(f.launches.length, 1);
  f.commander.stop(); t.mock.timers.tick(500); await run;
});

test('one planet can send multiple fleets to different attack targets while earlier fleets remain in flight', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fixture(false);
  const second = planet(10n, 3, 0); second.level = 1; second.ownerId = { toHexString: () => enemy }; f.snapshot.planets.push(second);
  const run = f.commander.start('attack', config()); await settle();
  t.mock.timers.tick(1500); await settle();
  assert.deepEqual(f.launches.map(l => [l.source, l.target]), [[1n, 9n], [1n, 10n]]);
  assert.equal(f.commander.states.attack.flights, 2);
  assert.ok(f.launches.reduce((n, l) => n + l.count, 0) <= 100);
  f.commander.stop(); t.mock.timers.tick(500); await run;
});

test('one overlapping source can fund expansion and attack concurrently without a per-planet operation lock', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fixture(false);
  const run = f.commander.start('expansion', config()); f.commander.start('attack', config());
  await settle(); t.mock.timers.tick(250); await settle();
  t.mock.timers.tick(1500); await settle();
  assert.deepEqual(f.launches.map(l => [l.source, l.target]), [[1n, 2n], [1n, 9n]]);
  assert.equal(f.commander.states.expansion.flights, 1);
  assert.equal(f.commander.states.attack.flights, 1);
  assert.ok(f.launches.reduce((n, l) => n + l.count, 0) <= 100);
  f.commander.stop(); t.mock.timers.tick(500); await run;
});

test('attack retains arrival deadlines and longest-first scheduling independently of the expansion journey cap', () => {
  const f = fixture(false);
  for (const id of [10n, 11n]) {
    const target = planet(id, Number(id - 7n), 0); target.level = 1; target.ownerId = f.hostile.ownerId;
    f.snapshot.planets.push(target);
  }
  const times = new Map([[9n, 10000], [10n, 110000], [11n, 180000]]);
  f.world.route = (_source, target) => ({ travelMs: times.get(target)!, lossPct: 0 });
  f.world.quote = (_source, target) => ({ count: 12, travelMs: times.get(target)! });
  const attackConfig = config(); attackConfig.settings.maxTravelMs = 10000;
  const plan = planAttack(f.world, f.snapshot, attackConfig, f.snapshot.budgets, new Set());
  assert.deepEqual(plan.jobs!.map(job => job.targetId), [10n, 9n]);
});

test('long-range expansion and attack share refreshed stock, dynamic guards and the slower transmission interval', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fixture(false); f.snapshot.budgets.set(1n, 62);
  f.snapshot.planets.push(planet(3n, 3, 0), planet(4n, 4, 0));
  f.world.route = (_source, target) => ({ travelMs: target === 9n ? 5000 : 180000, lossPct: 0 });
  f.world.quote = (_source, target) => ({ count: target === 9n ? 12 : 7, travelMs: target === 9n ? 5000 : 180000 });
  const expand = config(), attack = config();
  expand.settings.intervalMs = 1000; attack.settings.intervalMs = 2000;
  expand.settings.reserve = 5; attack.policy.frontlinePercent = 25;
  let pending: { source: bigint; count: number } | undefined;
  f.world.launch = async (source, target, count) => {
    assert.equal(pending, undefined, 'no next launch before inventory synchronization completes');
    assert.ok(count <= f.snapshot.budgets.get(source)! - reserveFor(f.source, f.snapshot, [expand, attack]));
    pending = { source, count }; f.launches.push({ source, target, count, time: Date.now() });
    await new Promise(resolve => setTimeout(resolve, 500));
  };
  f.world.syncInventory = async () => {
    await new Promise(resolve => setTimeout(resolve, 500));
    f.snapshot.budgets.set(pending!.source, f.snapshot.budgets.get(pending!.source)! - pending!.count); pending = undefined;
  };
  const run = f.commander.start('expansion', expand); f.commander.start('attack', attack);
  await settle();
  for (let i = 0; i < 32; i++) { t.mock.timers.tick(250); await settle(); }
  f.commander.stop(); t.mock.timers.tick(500); await run;
  assert.deepEqual(f.launches.map(job => job.target), [2n, 9n, 3n, 4n]);
  assert.deepEqual(f.launches.map(job => job.time), [100250, 102250, 104250, 106250]);
  assert.equal(f.snapshot.budgets.get(1n), 17);
  assert.equal(unresolved(), false);
});

test('stopping expansion during inventory sync preserves attack execution and the shared operation lock', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fixture(false); f.snapshot.budgets.set(1n, 60);
  let completeSync!: () => void;
  f.world.syncInventory = mock.fn(() => new Promise<void>(resolve => { completeSync = resolve; }));
  const run = f.commander.start('expansion', config()); f.commander.start('attack', config());
  await settle(); t.mock.timers.tick(250); await settle();
  assert.equal(f.launches.length, 1);
  f.commander.stop('expansion'); t.mock.timers.tick(5000); await settle();
  assert.equal(f.launches.length, 1);
  await assert.rejects(withControl(async () => {}), /正在运行/);
  f.snapshot.budgets.set(1n, 48); f.world.syncInventory = async () => {}; completeSync(); await settle();
  t.mock.timers.tick(250); await settle();
  assert.deepEqual(f.launches.map(job => job.target), [2n, 9n]);
  assert.equal(f.commander.states.expansion.running, false);
  assert.equal(f.commander.states.attack.running, true);
  assert.equal((f.world.dispose as any).mock.callCount(), 0);
  f.commander.stop(); t.mock.timers.tick(500); await run;
  assert.equal(unresolved(), false);
});

test('a confirmed expansion followed by inventory sync failure stops both modes without sending the reserved attack', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fixture(false);
  f.world.syncInventory = async () => { throw new Error('inventory barrier failed'); };
  const run = f.commander.start('expansion', config()); f.commander.start('attack', config());
  await settle(); t.mock.timers.tick(250); await run;
  assert.deepEqual(f.launches.map(job => job.target), [2n]);
  assert.equal(f.commander.states.expansion.sent, 1);
  for (const mode of ['expansion', 'attack'] as const) {
    assert.equal(f.commander.states[mode].running, false);
    assert.equal(f.commander.states[mode].activity, 'error');
    assert.match(f.commander.states[mode].phase, /inventory barrier failed/);
  }
  assert.equal(unresolved(), false, 'the launch receipt is known even though inventory refresh failed');
  assert.equal((f.world.dispose as any).mock.callCount(), 1);
});
