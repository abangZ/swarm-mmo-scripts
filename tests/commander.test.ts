import './helpers/browser';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Commander } from '../src/features/commander/engine';
import { defaults } from '../src/features/expansion/types';
import { defaultPolicy, type ModeConfig } from '../src/features/commander/types';
import { fakeWorld, fixture as gameFixture, planet, settle } from './helpers/fixtures';
import { unresolved, withControl } from '../src/runtime/operations';
import { planAttack } from '../src/features/attack/planner';
import { reserveFor } from '../src/features/commander/safety';
import { OffensivePlanner } from '../src/features/attack/rally';

const enemy = 'a'.repeat(64);

test('attack consumes its planned queue without empire replanning and refreshes each dispatch price', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fixture(false);
  for (const id of [10n, 11n, 12n]) f.snapshot.planets.push({ ...planet(id, Number(id) - 7, 0), level: 1, ownerId: f.hostile.ownerId });
  f.world.syncInventory = async () => {};
  f.world.launch = async (source, target, count) => {
    f.snapshot.budgets.set(source, f.snapshot.budgets.get(source)! - count);
    f.launches.push({ source, target, count, time: Date.now() });
  };
  const original = OffensivePlanner.prototype.steps;
  const plans = t.mock.method(OffensivePlanner.prototype, 'steps', original);
  const run = f.commander.start('attack', { ...config(), settings: { ...config().settings, scanMs: 30000 } }); await settle();
  assert.equal(f.launches.length, 1); assert.equal(plans.mock.callCount(), 1);
  // The second quote increases by 3; only 4 unreserved probes remain. It may
  // use those, but cannot spend the 48 already allocated to later attacks.
  f.world.quote = (_source, target) => ({ count: target === 10n ? 15 : 12, travelMs: 1000 });
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(1000); await settle(); }
  assert.deepEqual(f.launches.map(l => l.count), [24, 27, 24, 24]);
  assert.equal(plans.mock.callCount(), 1);
  assert.equal(f.snapshot.budgets.get(1n), 1);
  f.commander.stop(); t.mock.timers.tick(500); await run;
});

test('planet menu reads only the current session and follows queued, submitted and stopped attacks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fixture(false), { session } = gameFixture(f.snapshot.planets);
  f.world.matchesSession = menu => menu.conn === session.conn;
  localStorage.setItem('swarm-helper-last-attack-operation-v1', String(Date.now()));
  const run = f.commander.start('attack', config()); await settle();
  assert.match(f.commander.planetPlan(session, 9n).join(), /进攻 · 待执行 · #1 派 24 探针进攻本星/);
  assert.match(f.commander.planetPlan(session, 1n).join(), /派 24 探针进攻星球 #9/);
  assert.deepEqual(f.commander.planetPlan(gameFixture([]).session, 9n), ['等待当前游戏连接的规划']);
  assert.deepEqual(f.commander.planetPlan({ ...session, identity: 'other' }, 9n), ['等待当前游戏连接的规划']);
  t.mock.timers.tick(1000); await settle();
  assert.match(f.commander.planetPlan(session, 9n).join(), /进攻 · 已提交.*待核实占领/);
  f.commander.stop(); t.mock.timers.tick(500); await run;
  assert.deepEqual(f.commander.planetPlan(session, 9n), ['自动扩张和进攻均未运行']);
});

test('an invalid or more expensive queued attack releases its allocation without consuming other jobs', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fixture(false);
  for (const id of [10n, 11n]) f.snapshot.planets.push({ ...planet(id, Number(id) - 7, 0), level: 1, ownerId: f.hostile.ownerId });
  f.snapshot.budgets.set(1n, 72);
  f.world.syncInventory = async () => {};
  f.world.launch = async (source, target, count) => {
    f.snapshot.budgets.set(source, f.snapshot.budgets.get(source)! - count);
    f.launches.push({ source, target, count, time: Date.now() });
  };
  const run = f.commander.start('attack', config()); await settle();
  f.world.quote = (_source, target) => ({ count: target === 10n ? 30 : 12, travelMs: 1000 });
  for (let i = 0; i < 5; i++) { t.mock.timers.tick(250); await settle(); }
  assert.deepEqual(f.launches.map(l => l.target), [9n, 11n]);
  f.commander.stop(); t.mock.timers.tick(500); await run;
});
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

test('separate regions use independent intervals and stop independently', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fixture();
  f.snapshot.planets.push(planet(3n, 2, 0));
  for (const id of [10n, 11n]) { const target = planet(id, 102 + Number(id - 10n), 0); target.level = 1; target.ownerId = f.hostile.ownerId; f.snapshot.planets.push(target); }
  const expansion = config(); expansion.settings.intervalMs = 2000;
  const run = f.commander.start('expansion', expansion); f.commander.start('attack', config(100));
  await settle(); t.mock.timers.tick(250); await settle();
  assert.equal(f.create.mock.callCount(), 1);
  assert.equal(f.launches.filter(l => l.source === 1n).length, 1);
  assert.equal(f.launches.filter(l => l.source === 8n).length, 1);
  for (let i = 0; i < 8; i++) { t.mock.timers.tick(250); await settle(); }
  const attackTimes = f.launches.filter(l => l.source === 8n).map(l => l.time);
  const expansionTimes = f.launches.filter(l => l.source === 1n).map(l => l.time);
  assert.deepEqual(attackTimes, [100250, 101250, 102250]);
  assert.deepEqual(expansionTimes, [100250, 102250]);
  f.commander.stop('attack'); await settle();
  assert.equal(f.commander.states.attack.running, false); assert.equal(f.commander.states.expansion.running, true);
  assert.equal((f.world.dispose as any).mock.callCount(), 0);
  f.commander.stop(); await run;
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
  t.mock.timers.tick(120001); await settle(); t.mock.timers.tick(250); await settle();
  assert.equal(f.launches.length, 1); assert.equal(f.launches[0].target, 2n);
  f.commander.stop(); t.mock.timers.tick(500); await run;
});

test('alliance changes and new incoming fleets cancel queued attacks before transmission', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  for (const change of ['ally', 'fleet', 'inventory']) {
    const f = fixture(false);
    localStorage.setItem('swarm-helper-last-attack-operation-v1', String(Date.now()));
    const run = f.commander.start('attack', config()); await settle();
    if (change === 'ally') f.snapshot.allies!.add(enemy);
    if (change === 'fleet') f.snapshot.fleets!.push({ id: 33n, owner: enemy, target: 9n, count: 50, arrival: 200000, arriving: 50 });
    if (change === 'inventory') f.snapshot.budgets.set(1n, 1);
    t.mock.timers.tick(1500); await settle();
    assert.equal(f.launches.length, 0); assert.equal(unresolved(), false);
    f.commander.stop(); t.mock.timers.tick(500); await run;
  }
});

test('an uncertain launch stops further work in both lanes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fixture(); f.world.launch = mock.fn(async () => { throw new Error('unknown acknowledgement'); });
  const run = f.commander.start('expansion', config()); f.commander.start('attack', config(100));
  await settle(); t.mock.timers.tick(250); await run;
  assert.ok((f.world.launch as any).mock.callCount() <= 2);
  assert.equal(f.commander.states.expansion.activity, 'error'); assert.equal(f.commander.states.attack.activity, 'error');
  assert.equal(f.commander.states.expansion.running, false); assert.equal(f.commander.states.attack.running, false);
  assert.equal(unresolved(), true); assert.equal((f.world.dispose as any).mock.callCount(), 1);
});

test('adding a mode cancels its stale peer task and requires joint coverage before either sends', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  localStorage.setItem('swarm-helper-last-operation-v1', '100000');
  const f = fixture();
  const run = f.commander.start('expansion', config()); await settle();
  let finishScan!: () => void;
  f.world.scan = mock.fn(() => new Promise<void>(resolve => { finishScan = resolve; }));
  f.commander.start('attack', config(100)); await settle();
  t.mock.timers.tick(1500); await settle(); assert.equal(f.launches.length, 0);
  finishScan(); await settle();
  assert.equal(f.launches.length, 2);
  f.commander.stop(); await run;
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
  assert.deepEqual(f.launches.map(l => [l.source, l.target]), [[1n, 9n], [1n, 2n]]);
  assert.equal(f.commander.states.expansion.flights, 1);
  assert.equal(f.commander.states.attack.flights, 1);
  assert.ok(f.launches.reduce((n, l) => n + l.count, 0) <= 100);
  f.commander.stop(); t.mock.timers.tick(500); await run;
});

test('attack dispatch window and journey cap are independent and shorter journeys go first', () => {
  const f = fixture(false);
  for (const id of [10n, 11n]) {
    const target = planet(id, Number(id - 7n), 0); target.level = 1; target.ownerId = f.hostile.ownerId;
    f.snapshot.planets.push(target);
  }
  const times = new Map([[9n, 10000], [10n, 110000], [11n, 180000]]);
  f.world.route = (_source, target) => ({ travelMs: times.get(target)!, lossPct: 0 });
  f.world.quote = (_source, target) => ({ count: 12, travelMs: times.get(target)! });
  const attackConfig = config(); attackConfig.settings.maxTravelMs = 120000;
  const plan = planAttack(f.world, f.snapshot, attackConfig, f.snapshot.budgets, new Set());
  assert.deepEqual(plan.jobs!.map(job => job.targetId), [9n, 10n]);
});

test('shared sources retain inventory barriers and dynamic guards with separate lane intervals', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fixture(false); f.snapshot.budgets.set(1n, 62);
  f.snapshot.planets.push(planet(3n, 3, 0), planet(4n, 4, 0));
  f.world.route = (_source, target) => ({ travelMs: target === 9n ? 5000 : 180000, lossPct: 0 });
  f.world.quote = (_source, target) => ({ count: target === 9n ? 12 : 7, travelMs: target === 9n ? 5000 : 180000 });
  const expand = config(), attack = config();
  expand.settings.intervalMs = 1000; attack.settings.intervalMs = 2000;
  expand.settings.reserve = 5; attack.policy.frontlinePercent = 25;
  f.world.launch = async (source, target, count) => {
    assert.ok(count <= f.snapshot.budgets.get(source)! - reserveFor(f.source, f.snapshot, [expand, attack]));
    f.snapshot.budgets.set(source, f.snapshot.budgets.get(source)! - count);
    f.launches.push({ source, target, count, time: Date.now() });
    await new Promise(resolve => setTimeout(resolve, 500));
  };
  f.world.syncInventory = async () => {
    await new Promise(resolve => setTimeout(resolve, 500));
  };
  const run = f.commander.start('expansion', expand); f.commander.start('attack', attack);
  await settle();
  for (let i = 0; i < 32; i++) { t.mock.timers.tick(250); await settle(); }
  f.commander.stop(); t.mock.timers.tick(500); await run;
  assert.deepEqual(f.launches.map(job => job.target), [9n, 2n, 3n, 4n]);
  assert.ok(f.launches.every((job, i) => !i || job.time - f.launches[i - 1].time >= 1000));
  assert.ok(f.launches[1].time - f.launches[0].time < 2000, 'the old slower shared interval no longer applies');
  assert.equal(f.snapshot.budgets.get(1n), 17);
  assert.equal(unresolved(), false);
});

test('stopping expansion during inventory sync preserves attack execution and the shared operation lock', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fixture(false); f.snapshot.budgets.set(1n, 60);
  let completeSync!: () => void;
  let firstSync = true;
  f.world.syncInventory = mock.fn(async () => { if (firstSync) { firstSync = false; await new Promise<void>(resolve => { completeSync = resolve; }); } });
  const launch = f.world.launch;
  f.world.launch = async (source, target, count) => { f.snapshot.budgets.set(source, f.snapshot.budgets.get(source)! - count); await launch(source, target, count); };
  const run = f.commander.start('expansion', config()); await settle(); f.commander.start('attack', config());
  await settle(); t.mock.timers.tick(250); await settle();
  assert.equal(f.launches.length, 2, 'attack can use the unspent remainder while expansion inventory sync is pending');
  f.commander.stop('expansion'); t.mock.timers.tick(5000); await settle();
  assert.equal(f.launches.length, 2);
  await assert.rejects(withControl(async () => {}), /正在运行/);
  completeSync(); await settle();
  t.mock.timers.tick(250); await settle();
  assert.deepEqual(f.launches.map(job => job.target), [2n, 9n]);
  assert.equal(f.snapshot.budgets.get(1n), 24);
  assert.equal(f.commander.states.expansion.running, false);
  assert.equal(f.commander.states.attack.running, true);
  assert.equal((f.world.dispose as any).mock.callCount(), 0);
  f.commander.stop(); t.mock.timers.tick(500); await run;
  assert.equal(unresolved(), false);
});

test('a confirmed attack followed by inventory sync failure stops both modes before expansion can reuse the source', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fixture(false);
  f.world.syncInventory = async () => { throw new Error('inventory barrier failed'); };
  const run = f.commander.start('expansion', config()); f.commander.start('attack', config());
  await settle(); t.mock.timers.tick(250); await run;
  assert.deepEqual(f.launches.map(job => job.target), [9n]);
  assert.equal(f.commander.states.attack.sent, 1);
  for (const mode of ['expansion', 'attack'] as const) {
    assert.equal(f.commander.states[mode].running, false);
    assert.equal(f.commander.states[mode].activity, 'error');
    assert.match(f.commander.states[mode].phase, /inventory barrier failed/);
  }
  assert.equal(unresolved(), false, 'the launch receipt is known even though inventory refresh failed');
  assert.equal((f.world.dispose as any).mock.callCount(), 1);
});

test('a slow expansion receipt does not delay the attack lane or release the cross-tab lock on stop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fixture();
  for (const id of [10n, 11n, 12n]) { const p = planet(id, 102 + Number(id - 10n), 0); p.level = 1; p.ownerId = f.hostile.ownerId; f.snapshot.planets.push(p); }
  let acknowledge!: () => void;
  f.world.launch = async (source, target, count) => {
    f.launches.push({ source, target, count, time: Date.now() });
    if (source === 1n) await new Promise<void>(resolve => { acknowledge = resolve; });
  };
  const run = f.commander.start('expansion', config()); f.commander.start('attack', config(100));
  await settle();
  for (let i = 0; i < 13; i++) { t.mock.timers.tick(250); await settle(); }
  assert.deepEqual(f.launches.filter(l => l.source === 8n).map(l => l.time), [100250, 101250, 102250, 103250]);
  assert.equal(f.launches.filter(l => l.source === 1n).length, 1);
  assert.equal(unresolved(), false);
  f.commander.stop(); await settle();
  assert.equal((f.world.dispose as any).mock.callCount(), 0);
  await assert.rejects(withControl(async () => {}), /正在运行/);
  acknowledge(); await run;
  assert.equal((f.world.dispose as any).mock.callCount(), 1);
});

test('periodic scans cannot free an unacknowledged source, and a refreshed cache is debited only once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fixture(false); f.snapshot.budgets.set(1n, 60);
  f.snapshot.planets.push(planet(3n, 3, 0), planet(4n, 4, 0));
  let acknowledge!: () => void, synchronize!: () => void, firstSync = true;
  f.world.launch = async (source, target, count) => {
    f.launches.push({ source, target, count, time: Date.now() });
    assert.ok(count <= f.snapshot.budgets.get(source)!);
    f.snapshot.budgets.set(source, f.snapshot.budgets.get(source)! - count);
    if (target === 9n) await new Promise<void>(resolve => { acknowledge = resolve; });
  };
  f.world.syncInventory = async () => { if (firstSync) { firstSync = false; await new Promise<void>(resolve => { synchronize = resolve; }); } };
  const expansion = config(); expansion.settings.intervalMs = 1000;
  const run = f.commander.start('expansion', expansion); f.commander.start('attack', config());
  await settle(); t.mock.timers.tick(250); await settle();
  t.mock.timers.tick(10000); await settle();
  assert.equal(f.launches.length, 1); assert.ok((f.world.scan as any).mock.callCount() >= 2);
  acknowledge(); await settle();
  t.mock.timers.tick(1000); await settle(); assert.equal(f.launches.length, 1);
  synchronize(); await settle();
  for (let i = 0; i < 16; i++) { t.mock.timers.tick(250); await settle(); }
  assert.deepEqual(f.launches.map(l => l.target), [9n, 2n, 3n, 4n]);
  assert.equal(f.snapshot.budgets.get(1n), 0, 'all 36 remaining probes are usable after the 24-probe attack');
  assert.equal(f.launches.reduce((n, l) => n + l.count, 0), 60);
  f.commander.stop(); await run;
});

test('an unknown lane stops new sends while the other already-sent receipt retains ownership until it settles', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fixture();
  let rejectAttack!: (error: Error) => void, acknowledgeExpansion!: () => void;
  f.world.launch = (source, target, count) => {
    f.launches.push({ source, target, count, time: Date.now() });
    return source === 8n ? new Promise<void>((_resolve, reject) => { rejectAttack = reject; }) : new Promise<void>(resolve => { acknowledgeExpansion = resolve; });
  };
  const run = f.commander.start('expansion', config()); f.commander.start('attack', config(100));
  await settle(); t.mock.timers.tick(250); await settle();
  assert.equal(f.launches.length, 2);
  rejectAttack(new Error('attack result unknown')); await settle();
  t.mock.timers.tick(2000); await settle(); assert.equal(f.launches.length, 2);
  assert.equal((f.world.dispose as any).mock.callCount(), 0);
  await assert.rejects(withControl(async () => {}), /正在运行/);
  acknowledgeExpansion(); await run;
  assert.equal(unresolved(), true);
  for (const mode of ['attack', 'expansion'] as const) { assert.equal(f.commander.states[mode].activity, 'error'); assert.equal(f.commander.states[mode].running, false); }
  assert.equal((f.world.dispose as any).mock.callCount(), 1);
});

test('attack keeps its one-second cadence while expansion is still yielding through a large plan', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  let clock = 0; t.mock.method(performance, 'now', () => clock);
  const f = fixture();
  for (let i = 0; i < 420; i++) { const p = planet(BigInt(1000 + i), i % 5, 2, true); f.snapshot.planets.push(p); f.snapshot.owned.push(p); f.snapshot.budgets.set(p.planetId, 100); }
  for (const id of [10n, 11n, 12n]) { const p = planet(id, 102 + Number(id - 10n), 0); p.level = 1; p.ownerId = f.hostile.ownerId; f.snapshot.planets.push(p); }
  const quote = f.world.quote; f.world.quote = (source, target) => { if (target === 2n) clock += 10; return quote(source, target); };
  const run = f.commander.start('expansion', config()); f.commander.start('attack', config(100)); await settle();
  for (let i = 0; i < 13; i++) { t.mock.timers.tick(250); await settle(); }
  assert.ok(f.commander.states.expansion.work?.plan, 'the full expansion draft is still computing');
  assert.equal(f.commander.states.expansion.sent, 1, 'the small frontier draft can dispatch before the full plan completes');
  assert.deepEqual(f.launches.filter(l => l.target !== 2n).map(l => l.time), [100250, 101250, 102250, 103250]);
  f.commander.stop(); t.mock.timers.tick(0); await run;
});
