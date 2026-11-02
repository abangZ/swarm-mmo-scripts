import './helpers/browser';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { OffensivePlanner, rallyBatchSize } from '../src/features/attack/rally';
import { Commander } from '../src/features/commander/engine';
import { defaultPolicy, type ModeConfig } from '../src/features/commander/types';
import { defaults, members, totalCount } from '../src/features/expansion/types';
import type { ExpansionWorld, WorldSnapshot } from '../src/features/expansion/world';
import { planet, identity, settle } from './helpers/fixtures';
import { unresolved } from '../src/runtime/operations';

const enemy = 'a'.repeat(64);
function army() {
  const hub = planet(1n, 0, 0, true); hub.level = 5; hub.probeCount = 100;
  const target = planet(2n, 1, 0); target.level = 1; target.probeCount = 1000; target.ownerId = { toHexString: () => enemy }; target.lastUpdateTick = { toMillis: () => Date.now() };
  const donors = Array.from({ length: 300 }, (_, i) => { const p = planet(BigInt(i + 10), 5 + i % 30, 5 + Math.floor(i / 30), true); p.level = 1; p.probeCount = 10; return p; });
  const snapshot: WorldSnapshot = { planets: [hub, target, ...donors], owned: [hub, ...donors], identity: 'me', allies: new Set(['me']), intelligence: true, fleets: [], incoming: new Set(), automated: new Set(), budgets: new Map([[1n, 100], ...donors.map(p => [p.planetId, 10] as [bigint, number])]) };
  const config: ModeConfig = { settings: { ...defaults, maxSources: 1, maxTravelMs: 120000 }, policy: { ...defaultPolicy, zone: { x: 0, y: 0, radius: 64 }, rallyId: '1', frontlinePercent: 0 } };
  const world: ExpansionWorld = {
    scan: mock.fn(async () => {}), read: () => snapshot,
    quote: (source, id) => { const p = snapshot.planets.find(p => p.planetId === id)!; return (snapshot.budgets.get(source) ?? 0) >= p.probeCount + 1 ? { count: p.probeCount + 3, travelMs: 5000 } : null; },
    route: (_source, id) => ({ travelMs: snapshot.owned.some(p => p.planetId === id) ? 10000 : 5000, lossPct: 0 }),
    launch: mock.fn(async () => {}), launchGroup: mock.fn(async () => {}), dispose: mock.fn(),
  };
  return { hub, target, donors, snapshot, config, world };
}
const pending = () => ({ count: 0, arrival: Date.now() });
const guard = () => ({ percent: 0, deficit: 0 });

test('long-range expansion shares reserved donor stock with an independent rally queue', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = army();
  for (const id of [6000n, 6001n]) { const neutral = planet(id, 0, -1); neutral.probeCount = 5; f.snapshot.planets.push(neutral); }
  f.world.route = (_source, target) => ({ travelMs: target >= 6000n ? 180000 : target === 1n ? 10000 : 5000, lossPct: 0 });
  f.world.quote = (source, target) => {
    const count = f.snapshot.planets.find(p => p.planetId === target)!.probeCount + 2;
    return count <= f.snapshot.budgets.get(source)! ? { count, travelMs: target >= 6000n ? 180000 : 5000 } : null;
  };
  const attackConfig = { ...f.config, settings: { ...f.config.settings, intervalMs: 3000 } };
  const reserved = new OffensivePlanner().plan(f.world, f.snapshot, attackConfig, f.snapshot.budgets, new Set(), pending, guard).reservations;
  const initial = new Map(f.snapshot.budgets);
  const sent: { target: bigint; time: number }[] = [];
  const spend = (source: bigint, count: number) => {
    assert.ok(count <= f.snapshot.budgets.get(source)!, 'shared inventory cannot be spent twice');
    f.snapshot.budgets.set(source, f.snapshot.budgets.get(source)! - count);
  };
  f.world.launch = async (source, target, count) => {
    if (!sent.length) assert.ok(count <= initial.get(source)! - (reserved.get(source) ?? 0), 'first expansion preserves the entire rally reservation');
    spend(source, count); sent.push({ target, time: Date.now() });
  };
  f.world.launchGroup = async job => {
    assert.equal(job.kind, 'reinforce'); assert.ok(members(job).length >= 1 && members(job).length <= 50);
    for (const member of members(job)) spend(member.sourceId, member.count);
    sent.push({ target: job.targetId, time: Date.now() });
  };
  f.world.syncInventory = async () => {};
  const commander = new Commander(() => {}, () => f.world);
  const run = commander.start('expansion', { ...f.config, settings: { ...f.config.settings, maxTravelMs: defaults.maxTravelMs } }); commander.start('attack', f.config);
  await settle(); t.mock.timers.tick(250); await settle();
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(1500); await settle(); }
  commander.stop(); t.mock.timers.tick(500); await run;
  assert.deepEqual(sent.filter(job => job.target >= 6000n).map(job => job.target), [6000n, 6001n]);
  const rallies = sent.filter(job => job.target === 1n);
  assert.ok(rallies.length >= 2);
  assert.ok(rallies.every((job, i) => !i || job.time - rallies[i - 1].time >= 1000));
  assert.equal(unresolved(), false);
});

function mixedFront() {
  const f = army();
  const near = planet(500n, 2, 5, true); near.level = 1; near.probeCount = 100;
  f.snapshot.owned.push(near); f.snapshot.planets.push(near); f.snapshot.budgets.set(near.planetId, 100);
  for (const id of [501n, 502n]) {
    const target = planet(id, Number(id - 498n), 5); target.level = 1; target.probeCount = 5;
    target.ownerId = { toHexString: () => enemy }; target.lastUpdateTick = { toMillis: () => Date.now() };
    f.snapshot.planets.push(target);
  }
  return { ...f, near };
}

test('a fixed hub does not monopolize attacks: nearby captures and remote gathering have disjoint amount budgets', () => {
  const f = mixedFront(), planner = new OffensivePlanner();
  const plan = planner.plan(f.world, f.snapshot, f.config, f.snapshot.budgets, new Set(), pending, guard);
  const direct = plan.jobs!.filter(j => j.kind !== 'reinforce');
  assert.equal(direct.length, 2); assert.ok(direct.every(j => j.sourceId === 500n));
  assert.equal(plan.rally?.targetId, 1n); assert.equal(plan.rallyState?.target, 2n);
  assert.equal(plan.next?.kind, undefined);
  assert.ok(plan.reservations.size > 100);
  for (const [id, count] of plan.reservations) assert.ok(count <= f.snapshot.budgets.get(id)!, `overcommitted ${id}`);
  assert.ok(plan.reservations.get(500n)! > direct.reduce((n, j) => n + j.count, 0), 'a nearby source may donate its remaining stock');
});

test('direct attacks alternate with gathering without cancelling it, and unrelated captures do not relocate its hub', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = mixedFront(), sent: { kind: string; target: bigint; time: number }[] = [];
  f.world.launch = mock.fn(async (_source, target) => { sent.push({ kind: 'direct', target, time: Date.now() }); });
  f.world.launchGroup = mock.fn(async job => { sent.push({ kind: 'reinforce', target: job.targetId, time: Date.now() }); });
  const commander = new Commander(() => {}, () => f.world);
  const run = commander.start('attack', f.config); await settle();
  for (let i = 0; i < 2; i++) { t.mock.timers.tick(1500); await settle(); }
  assert.deepEqual(sent.map(j => j.kind), ['direct', 'reinforce', 'direct']);
  assert.ok(sent.slice(1).every((j, i) => j.time - sent[i].time >= 1500));
  assert.equal(commander.states.attack.rally?.hub, 1n);
  const captured = f.snapshot.planets.find(p => p.planetId === sent[0].target)!;
  captured.ownerId = identity; f.snapshot.owned.push(captured); f.snapshot.budgets.set(captured.planetId, 10);
  t.mock.timers.tick(10000); await settle();
  assert.equal(commander.states.attack.captured, 1);
  assert.equal(commander.states.attack.rally?.hub, 1n);
  commander.stop(); t.mock.timers.tick(500); await run;
});

test('an affordable nearby source can take the gathering target directly and cancel its unsent supply', () => {
  const f = army(), planner = new OffensivePlanner();
  const gathering = planner.plan(f.world, f.snapshot, f.config, f.snapshot.budgets, new Set(), pending, guard);
  assert.ok(gathering.rally);
  f.snapshot.budgets.set(f.donors[0].planetId, 3000);
  const plan = planner.plan(f.world, f.snapshot, f.config, f.snapshot.budgets, new Set(), pending, guard);
  assert.equal(plan.job?.sourceId, f.donors[0].planetId); assert.equal(plan.job?.targetId, 2n);
  assert.equal(plan.rally, undefined);
  planner.launched(plan.job!, f.config);
  assert.equal(planner.refresh(f.world, f.snapshot, f.config, f.snapshot.budgets, gathering.rally!), null);
});

test('hundreds of sources can fund one friendly hub independently of the expansion maxSources setting', () => {
  const f = army(), planner = new OffensivePlanner();
  const plan = planner.plan(f.world, f.snapshot, f.config, f.snapshot.budgets, new Set(), pending, guard);
  assert.equal(plan.job, undefined);
  assert.equal(plan.rally?.kind, 'reinforce'); assert.equal(plan.rally?.targetId, 1n);
  assert.equal(members(plan.rally!).length, rallyBatchSize);
  assert.ok(plan.rallyState!.sources > 100);
  assert.ok(plan.reservations.size > 100);
  assert.ok(members(plan.rally!).every(m => m.sourceId !== 1n && m.count <= f.snapshot.budgets.get(m.sourceId)!));
  assert.equal(plan.rallyState!.target, 2n);
});

test('army gathering batches share the rate limit and cannot attack until troops actually arrive', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = army();
  let nextFleet = 1n;
  const batches: { time: number; size: number }[] = [];
  f.world.launchGroup = mock.fn(async job => {
    batches.push({ time: Date.now(), size: members(job).length });
    for (const member of members(job)) {
      f.snapshot.budgets.set(member.sourceId, f.snapshot.budgets.get(member.sourceId)! - member.count);
      const fleet = { id: nextFleet++, target: job.targetId, owner: 'me', count: member.count, arriving: member.count, arrival: Date.now() + member.travelMs };
      f.snapshot.fleets!.push(fleet); f.snapshot.incoming.add(job.targetId);
      setTimeout(() => {
        f.snapshot.budgets.set(job.targetId, f.snapshot.budgets.get(job.targetId)! + member.count);
        f.snapshot.fleets!.splice(f.snapshot.fleets!.indexOf(fleet), 1);
        if (!f.snapshot.fleets!.some(f => f.target === job.targetId)) f.snapshot.incoming.delete(job.targetId);
      }, member.travelMs);
    }
  });
  const commander = new Commander(() => {}, () => f.world);
  const run = commander.start('attack', f.config); await settle();
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(1500); await settle(); }
  assert.ok(batches.length >= 3);
  assert.ok(batches.reduce((sum, b) => sum + b.size, 0) > 100);
  assert.ok(batches.every(b => b.size <= 50));
  assert.ok(batches.slice(1).every((b, i) => b.time - batches[i].time >= 1500));
  assert.equal((f.world.launch as any).mock.callCount(), 0, 'in-flight supply is not spendable inventory');
  assert.equal(commander.states.attack.captured, 0, 'reinforcing an owned hub is not a capture');
  t.mock.timers.tick(10000); await settle();
  assert.equal((f.world.launch as any).mock.callCount(), 1);
  assert.deepEqual((f.world.launch as any).mock.calls[0].arguments.slice(0, 2), [1n, 2n]);
  assert.ok((f.world.launch as any).mock.calls[0].arguments[2] <= f.snapshot.budgets.get(1n)!);
  commander.stop(); t.mock.timers.tick(500); await run;
});

test('gathering rechecks every donor and hub ownership instead of sending a partial stale batch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  for (const change of ['donor', 'hub', 'automation', 'incoming', 'funded']) {
    const f = army();
    localStorage.setItem('swarm-helper-last-attack-operation-v1', String(Date.now()));
    const commander = new Commander(() => {}, () => f.world);
    const run = commander.start('attack', f.config); await settle();
    const job = commander.states.attack.queue[0]; assert.equal(job.kind, 'reinforce');
    if (change === 'donor') f.snapshot.budgets.set(job.sourceId, 0);
    if (change === 'hub') f.snapshot.owned.splice(f.snapshot.owned.indexOf(f.hub), 1);
    if (change === 'automation') f.snapshot.automated!.add(1n);
    if (change === 'incoming') f.snapshot.fleets!.push({ id: 999n, owner: enemy, target: 1n, count: 10, arriving: 10, arrival: Date.now() + 5000 });
    if (change === 'funded') f.snapshot.budgets.set(1n, 10000);
    t.mock.timers.tick(1500); await settle();
    assert.equal((f.world.launchGroup as any).mock.callCount(), 0);
    assert.equal((f.world.launch as any).mock.callCount(), 0);
    assert.equal(unresolved(), false);
    commander.stop(); t.mock.timers.tick(500); await run;
  }
});

test('gathering includes the hub reserve shortfall and production while waiting, and avoids besieged hubs', () => {
  const f = army(), planner = new OffensivePlanner();
  const normal = planner.plan(f.world, f.snapshot, f.config, f.snapshot.budgets, new Set(), pending, guard);
  planner.reset();
  const guarded = planner.plan(f.world, f.snapshot, f.config, f.snapshot.budgets, new Set(), pending, () => ({ percent: 10, deficit: 50 }));
  assert.ok([...guarded.reservations.values()].reduce((a, b) => a + b, 0) > [...normal.reservations.values()].reduce((a, b) => a + b, 0));
  planner.reset(); f.snapshot.fleets!.push({ id: 1n, target: 1n, owner: enemy, count: 1, arriving: 1, arrival: Date.now() + 5000 });
  assert.equal(planner.plan(f.world, f.snapshot, f.config, f.snapshot.budgets, new Set(), pending, guard).rally, undefined);
});

test('captured forward points become the next hub inside the same fixed zone; users can keep the initial hub', () => {
  for (const advanceHub of [true, false]) {
    const f = army(); f.config.policy.advanceHub = advanceHub;
    const planner = new OffensivePlanner();
    f.target.ownerId = identity; f.target.probeCount = 100; f.snapshot.owned.push(f.target); f.snapshot.budgets.set(2n, 100);
    const next = planet(3n, 3, 0); next.level = 1; next.probeCount = 1200; next.ownerId = { toHexString: () => enemy }; next.lastUpdateTick = { toMillis: () => Date.now() }; f.snapshot.planets.push(next);
    planner.launched({ sourceId: 1n, targetId: 2n, count: 1015, travelMs: 5000 }, f.config);
    planner.captured(2n, f.config);
    const plan = planner.plan(f.world, f.snapshot, f.config, f.snapshot.budgets, new Set(), pending, guard);
    assert.equal(plan.rallyState?.hub, advanceHub ? 2n : 1n);
    assert.equal(plan.rallyState?.target, 3n);
    assert.deepEqual(f.config.policy.zone, { x: 0, y: 0, radius: 64 });
  }
});

test('unknown bulk gathering stops without retrying donors as individual operations', async () => {
  const f = army(); f.world.launchGroup = mock.fn(async () => { throw new Error('unknown bulk result'); });
  const commander = new Commander(() => {}, () => f.world);
  await commander.start('attack', f.config);
  assert.equal((f.world.launchGroup as any).mock.callCount(), 1);
  assert.equal((f.world.launch as any).mock.callCount(), 0);
  assert.equal(commander.states.attack.activity, 'error'); assert.equal(unresolved(), true);
});

test('confirmed forward capture replaces an already planned campaign at the previous hub', () => {
  const f = army(), planner = new OffensivePlanner();
  planner.launched({ sourceId: 1n, targetId: 3n, count: 10, travelMs: 5000 }, f.config);
  const old = planner.plan(f.world, f.snapshot, f.config, f.snapshot.budgets, new Set(), pending, guard);
  assert.ok(old.rally);
  const forward = planet(3n, 2, 0, true); forward.level = 1;
  f.snapshot.owned.push(forward); f.snapshot.planets.push(forward); f.snapshot.budgets.set(3n, 10000);
  planner.captured(3n, f.config);
  assert.equal(planner.refresh(f.world, f.snapshot, f.config, f.snapshot.budgets, old.rally!), null);
  const next = planner.plan(f.world, f.snapshot, f.config, f.snapshot.budgets, new Set(), pending, guard);
  assert.equal(next.job?.sourceId, 3n); assert.equal(next.job?.targetId, 2n);
});

test('landed supply is not promised a second time to fund the next campaign', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = army(); f.config.policy.advanceHub = false;
  f.world.route = (source, target) => ({ travelMs: target === 1n ? 10000 : source === 1n ? 5000 : 200000, lossPct: 0 });
  for (const p of f.donors) f.snapshot.budgets.set(p.planetId, 0);
  f.snapshot.budgets.set(f.donors[0].planetId, 3000);
  f.world.launch = mock.fn(async (source, target, count) => {
    f.snapshot.budgets.set(source, f.snapshot.budgets.get(source)! - count);
    if (target === 1n) {
      setTimeout(() => f.snapshot.budgets.set(1n, f.snapshot.budgets.get(1n)! + count), 10000);
    } else {
      // The first strike has spent its supply; another consumer uses the remainder.
      for (const id of f.snapshot.budgets.keys()) f.snapshot.budgets.set(id, 0);
      const next = planet(3n, 3, 0); next.ownerId = { toHexString: () => enemy }; next.probeCount = 1; next.level = 1; next.lastUpdateTick = { toMillis: () => Date.now() };
      f.snapshot.planets.push(next);
    }
  });
  const commander = new Commander(() => {}, () => f.world);
  const run = commander.start('attack', f.config); await settle();
  assert.equal((f.world.launch as any).mock.callCount(), 1);
  t.mock.timers.tick(10000); await settle();
  assert.equal((f.world.launch as any).mock.callCount(), 2);
  t.mock.timers.tick(1500); await settle();
  assert.equal(commander.states.attack.rally, undefined, 'no resources remain to start another gathering campaign');
  assert.equal((f.world.launch as any).mock.callCount(), 2);
  commander.stop(); t.mock.timers.tick(500); await run;
});

test('a donor can fund both gathering and expansion with its unreserved remainder', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = army(); const donor = f.donors[0]; f.snapshot.budgets.set(donor.planetId, 10000);
  f.world.route = (source, target) => ({ travelMs: target === 1n ? 10000 : target === 2n && source !== 1n ? 200000 : 5000, lossPct: 0 });
  const neutral = planet(3n, 2, 0); neutral.probeCount = 0; neutral.level = 1; f.snapshot.planets.push(neutral);
  const quote = f.world.quote;
  f.world.quote = (source, target) => target === 3n && source !== donor.planetId ? null : quote(source, target);
  const commander = new Commander(() => {}, () => f.world);
  const run = commander.start('expansion', { ...f.config, policy: { ...f.config.policy, rallyId: null } });
  commander.start('attack', f.config); await settle(); t.mock.timers.tick(250); await settle();
  t.mock.timers.tick(1500); await settle();
  const calls = (f.world.launch as any).mock.calls.map((c: any) => c.arguments);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c: any[]) => [c[0], c[1]]), [[donor.planetId, 1n], [donor.planetId, 3n]]);
  assert.ok(calls.reduce((n: number, c: any[]) => n + c[2], 0) <= 10000);
  commander.stop(); t.mock.timers.tick(500); await run;
});
