import './helpers/browser';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { LogisticsPlanner, readyAfter, logisticsQuoteBudget } from '../src/features/expansion/logistics';
import { finishPlanning } from '../src/runtime/planning';
import { defaults, members } from '../src/features/expansion/types';
import { defaultPolicy } from '../src/features/commander/types';
import { Commander } from '../src/features/commander/engine';
import { BackgroundPlanner } from '../src/features/expansion/background-planner';
import { fakeWorld, planet, settle, identity } from './helpers/fixtures';

const config = () => ({ settings: { ...defaults, stableMs: 0 }, policy: { ...defaultPolicy, frontlinePercent: 0 } });
function army(count = 0, kind: 'planet' | 'sun' = 'planet') {
  const f = fakeWorld(); f.source.level = 1;
  const donors = Array.from({ length: count }, (_, i) => ({ ...planet(BigInt(10 + i), -10 - i, 0, true), level: 1 }));
  f.snapshot.owned.push(...donors); f.snapshot.planets.push(...donors);
  for (const p of f.snapshot.owned) f.snapshot.budgets.set(p.planetId, 100);
  Object.assign(f.snapshot, { quoteVersion: 'rules-1', attackMultiplierUpperBound: 1, identity: 'me', intelligence: true, allies: new Set(['me']), automated: new Set(), fleets: [], bodyFleets: new Map() });
  f.target.probeCount = 399;
  f.snapshot.suns = kind === 'sun' ? [{ sunId: 2n, positionX: 1, positionY: 0, galaxyId: 1n, probeCount: 120 }] : [];
  if (kind === 'sun') f.snapshot.planets = [...f.snapshot.owned];
  f.world.route = (source, target) => ({ travelMs: target === 1n ? 10000 : source === 1n ? 1000 : 99999999, lossPct: 0 });
  f.world.routeBody = source => ({ travelMs: source === 1n ? 1000 : 99999999, lossPct: 0 });
  f.world.quote = source => (f.snapshot.budgets.get(source) ?? 0) >= f.target.probeCount + 1 ? { count: f.target.probeCount + 1, travelMs: 1000 } : null;
  f.world.quoteBody = source => (f.snapshot.budgets.get(source) ?? 0) >= 12100 ? { count: 12100, travelMs: 1000 } : null;
  f.world.launchGroup = mock.fn(async () => {}); f.world.launchBody = mock.fn(async () => {}); f.world.upgradeMany = mock.fn(async () => {});
  const planner = new LogisticsPlanner(kind), cfg = config();
  const plan = () => finishPlanning(planner.steps(f.world, f.snapshot, cfg, f.snapshot.budgets, new Set()));
  return { ...f, donors, planner, cfg, plan };
}

test('frontier upgrades only when the production-and-supply ETA improves, without spending forecasts', () => {
  const f = army();
  const plan = f.plan();
  assert.equal(plan.job?.kind, 'upgrade'); assert.equal(plan.job.expectedLevel, 1);
  assert.ok(plan.state!.upgradeMs! < plan.state!.readyMs);
  assert.equal(plan.job.count, 100); assert.ok(f.planner.validUpgrade(plan.job, f.snapshot, f.cfg, 100));
  f.snapshot.budgets.set(1n, 99);
  assert.equal(f.planner.validUpgrade(plan.job, f.snapshot, f.cfg, 99), false);
  assert.notEqual(f.plan().job?.kind, 'upgrade');
});

test('near-term rear supply wins over upgrading; new incoming intelligence invalidates a queued upgrade', () => {
  const f = army(1); f.snapshot.budgets.set(10n, 400);
  const plan = f.plan(); assert.equal(plan.job?.kind, 'expansion-supply'); assert.equal(plan.job.count, 300);
  const isolated = army(); const upgrade = isolated.plan().job!;
  isolated.snapshot.fleets = [{ id: 99n, owner: 'me', target: 1n, count: 300, arriving: 300, arrival: Date.now() + 10000 }];
  assert.equal(isolated.planner.validUpgrade(upgrade, isolated.snapshot, isolated.cfg, 100), false);
  assert.equal(isolated.plan().job, undefined);
});

test('rear supply restores the hub fixed defense shortfall before funding conquest', () => {
  const f = army(5); f.snapshot.budgets.set(1n, 0);
  const plan = finishPlanning(f.planner.steps(f.world, f.snapshot, f.cfg, f.snapshot.budgets, new Set(), () => ({ percent: 0, deficit: 50 })));
  assert.equal(plan.job?.kind, 'expansion-supply');
  assert.equal(members(plan.job!).reduce((n, m) => n + m.count, 0), 450);
});

test('an uncertain combat discount cannot turn a slower upgrade into an apparently faster capture', () => {
  const f = army(); f.snapshot.attackMultiplierUpperBound = 2;
  assert.notEqual(f.plan().job?.kind, 'upgrade', 'compare against the optimistic unupgraded capture cost');
});

test('an affordable new neighbor is captured without abandoning the persistent expensive goal', () => {
  const f = army(); f.world.upgradeMany = undefined;
  f.plan(); assert.equal(f.planner.target, 2n);
  f.snapshot.planets.push({ ...planet(3n, 0, 1), probeCount: 10 });
  f.world.quote = (_source, target) => target === 3n ? { count: 12, travelMs: 1000 } : null;
  const nearby = f.plan().job!; assert.equal(nearby.targetId, 3n);
  f.planner.launched(nearby, f.snapshot); assert.equal(f.planner.target, 2n);
});

for (const kind of ['planet', 'sun'] as const) test(`${kind} recruits over 100 sources in persistent batches of 50, waits for stock, and never re-funds in-flight batches`, () => {
  const f = army(130, kind); f.cfg.settings.maxSources = 1; f.target.probeCount = 12099;
  const sizes: number[] = [], donors = new Set<bigint>();
  let total = 0;
  for (let n = 0; n < 4; n++) {
    const plan = f.plan(); if (!plan.job) break;
    assert.equal(plan.job.kind, kind === 'sun' ? 'sun-supply' : 'expansion-supply');
    const batch = members(plan.job); sizes.push(batch.length);
    f.planner.launched(plan.job, f.snapshot);
    for (const m of batch) { assert.ok(!donors.has(m.sourceId)); donors.add(m.sourceId); total += m.count; f.snapshot.budgets.set(m.sourceId, f.snapshot.budgets.get(m.sourceId)! - m.count); }
  }
  assert.deepEqual(sizes, [50, 50, 20]); assert.equal(total, 12000);
  assert.equal(f.plan().job, undefined, 'incoming supply is not current spendable stock');
  f.snapshot.budgets.set(1n, 12100);
  const attack = f.plan().job!; assert.equal(attack.kind, undefined); assert.equal(attack.targetKind, kind); assert.equal(attack.count, 12100);
});

test('unknown incoming supply and changed target ownership invalidate funding without assuming zero threat', () => {
  const f = army(4), plan = f.plan(); assert.equal(plan.job?.kind, 'expansion-supply');
  f.target.ownerId = { toHexString: () => 'enemy' };
  assert.equal(f.planner.validSupply(plan.job!, f.snapshot, f.cfg), false);
  f.target.ownerId = undefined;
  f.snapshot.fleets = [{ id: 99n, owner: 'me', target: 1n, count: null, arriving: null, arrival: null }];
  assert.equal(f.plan().job, undefined);
});

test('6000 rear sources have bounded cold route work, zero warm route calls, and stock changes reuse geometry', t => {
  const f = army(6000); f.target.probeCount = 1000000;
  f.world.upgradeMany = undefined;
  const route = t.mock.method(f.world, 'route', f.world.route!);
  const started = process.hrtime.bigint();
  let plan;
  for (let pass = 0; pass < 60; pass++) {
    const before = route.mock.callCount(); plan = f.plan();
    assert.ok(route.mock.callCount() - before <= logisticsQuoteBudget);
    if (plan.state?.checked === plan.state?.total) break;
  }
  assert.equal(plan!.state!.checked, 6000);
  const cold = route.mock.callCount(); f.plan(); assert.equal(route.mock.callCount(), cold);
  f.snapshot.budgets.set(10n, 200); f.plan(); assert.equal(route.mock.callCount(), cold);
  assert.equal((f.world.scan as any).mock.callCount(), 0, 'planning never requests subscriptions or server snapshots');
  t.diagnostic(`6001 sources: cold ${cold} route calls, warm 0, stock-only change 0; ${(Number(process.hrtime.bigint() - started) / 1e6).toFixed(1)}ms simulated total`);
});

test('ETA accounts for the earliest sufficient arrival prefix rather than waiting for every donor', () => {
  assert.equal(readyAfter(100, 1, 60000, 400, [{ count: 300, at: 10000 }, { count: 1, at: 600000 }]), 10000);
  assert.equal(readyAfter(100, 1, 60000, 400, []), 18000000);
});

test('the commander keeps a multi-batch rear supply campaign, then attacks only after actual inventory arrives', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = army(130); f.target.probeCount = 12099; f.cfg.settings.upgradeStable = 0; f.cfg.settings.stableMs = 600000;
  const batches: number[] = [], captures: bigint[] = [];
  f.world.launchGroup = async job => {
    batches.push(members(job).length);
    for (const m of members(job)) {
      assert.ok(m.count <= f.snapshot.budgets.get(m.sourceId)!);
      f.snapshot.budgets.set(m.sourceId, f.snapshot.budgets.get(m.sourceId)! - m.count);
    }
  };
  f.world.launch = async (source, target, count) => {
    assert.ok(count <= f.snapshot.budgets.get(source)!); captures.push(target);
    f.snapshot.budgets.set(source, f.snapshot.budgets.get(source)! - count);
    f.target.ownerId = identity;
  };
  f.world.syncInventory = async () => {};
  const commander = new Commander(() => {}, () => f.world), run = commander.start('expansion', f.cfg); await settle();
  for (let i = 0; i < 5; i++) { t.mock.timers.tick(1500); await settle(); }
  assert.deepEqual(batches, [50, 50, 20]); assert.deepEqual(captures, []);
  f.snapshot.budgets.set(1n, 12100);
  t.mock.timers.tick(1500); await settle();
  assert.deepEqual(captures, [2n]);
  commander.stop(); await run;
});

test('the commander executes an ETA-approved frontier upgrade despite nearby neutral targets', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = army(); f.cfg.settings.stableMs = 600000;
  let upgrades = 0;
  f.world.upgradeMany = async ids => { assert.deepEqual(ids, [1n]); upgrades++; f.source.level = 2; f.snapshot.budgets.set(1n, 0); };
  f.world.syncInventory = async () => {};
  const commander = new Commander(() => {}, () => f.world), run = commander.start('expansion', f.cfg); await settle();
  assert.equal(upgrades, 0);
  t.mock.timers.tick(600000); await settle();
  t.mock.timers.tick(1500); await settle();
  assert.equal(upgrades, 1); assert.equal(commander.states.expansion.metrics!.upgrades, 1);
  assert.equal((f.world.launch as any).mock.callCount(), 0);
  commander.stop(); await run;
});

test('stopping cancels a sliced logistics draft without publishing reservations or sending its batch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = army(130); f.target.probeCount = 12099; f.cfg.settings.stableMs = 600000;
  let time = 0; const route = f.world.route!;
  t.mock.method(performance, 'now', () => time);
  f.world.route = (...args) => { time += 10; return route(...args); };
  const commander = new Commander(() => {}, () => f.world), run = commander.start('expansion', f.cfg); await settle();
  commander.stop(); t.mock.timers.tick(0); await run;
  assert.equal((f.world.launchGroup as any).mock.callCount(), 0); assert.equal(commander.states.expansion.queue.length, 0);
});

test('unchanged ordinary expansion proposals are reused, but inventory and fleet changes invalidate them', async () => {
  const f = army(), planner = new BackgroundPlanner();
  f.target.probeCount = 10;
  const signal = new AbortController().signal;
  const first = await planner.proposals(f.world, f.snapshot, f.cfg, f.snapshot.budgets, new Set(), signal, () => true);
  const unchanged = await planner.proposals(f.world, f.snapshot, f.cfg, f.snapshot.budgets, new Set(), signal, () => true);
  assert.equal(unchanged, first);
  f.snapshot.budgets.set(1n, 101);
  const changed = await planner.proposals(f.world, f.snapshot, f.cfg, f.snapshot.budgets, new Set(), signal, () => true);
  assert.notEqual(changed, first);
  f.snapshot.incoming.add(2n);
  const blocked = await planner.proposals(f.world, f.snapshot, f.cfg, f.snapshot.budgets, new Set(), signal, () => true);
  assert.equal(blocked!.edges.length, 0);
});

test('known cross-galaxy supply is deduplicated by source/count/arrival while unmatched unknown supply pauses recruitment', () => {
  const f = army(130); f.target.probeCount = 12099;
  const first = f.plan().job!;
  f.planner.launched(first, f.snapshot);
  f.snapshot.fleets = members(first).map((m, i) => ({ id: BigInt(i + 1), owner: 'me', source: m.sourceId, target: 1n, count: m.count, arriving: null, arrival: Date.now() + m.travelMs }));
  for (const m of members(first)) f.snapshot.budgets.set(m.sourceId, 0);
  const second = f.plan();
  assert.equal(members(second.job!).length, 50); assert.equal(second.state!.incoming, 5000);
  f.snapshot.fleets.push({ id: 999n, owner: 'me', source: 999n, target: 1n, count: 500, arriving: null, arrival: Date.now() + 10000 });
  assert.equal(f.plan().job, undefined);
});
