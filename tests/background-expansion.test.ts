import './helpers/browser';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Commander } from '../src/features/commander/engine';
import { BackgroundPlanner } from '../src/features/expansion/background-planner';
import { FrontierPlanner } from '../src/features/expansion/frontier';
import type { ExpansionState } from '../src/features/expansion/engine';
import { defaults, members } from '../src/features/expansion/types';
import { defaultPolicy } from '../src/features/commander/types';
import { fakeWorld, planet, settle } from './helpers/fixtures';

// Hold a completed draft to exercise inventory changes and cancellation before
// publication, independently of how the planner schedules its time slices.
function delayProposals(wait: (round: number, signal: AbortSignal) => Promise<void> | void) {
  const original = BackgroundPlanner.prototype.proposals;
  let rounds = 0;
  mock.method(BackgroundPlanner.prototype, 'proposals', async function(this: BackgroundPlanner, ...args: Parameters<typeof original>) {
    const result = await original.apply(this, args);
    await wait(++rounds, args[5]);
    return args[5].aborted || !args[6]() ? undefined : result;
  });
}
function paused(signal: AbortSignal, ready: (release: () => void) => void) {
  return new Promise<void>(resolve => {
    const release = () => { signal.removeEventListener('abort', release); resolve(); };
    if (signal.aborted) { release(); return; }
    signal.addEventListener('abort', release, { once: true });
    ready(release);
  });
}

const config = { settings: { ...defaults, scanMs: 10000, intervalMs: 1200, candidates: 50, radius: 64, maxSources: 1 }, policy: { ...defaultPolicy, frontlinePercent: 0 } };

test('meteorites dispatch independently of an unfinished global draft and are never double-published', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  let release!: () => void;
  delayProposals((round, signal) => { if (round === 1) return paused(signal, resume => { release = resume; }); });
  const f = fakeWorld(); f.world.quote = () => null;
  const comet = { meteoriteId: 2n, positionX: 1, positionY: 0, galaxyId: 1n, probeCount: 1, expiresAt: { toMillis: () => 160000 } };
  f.snapshot.meteorites = [comet]; f.snapshot.budgets.set(1n, 3);
  f.world.quoteBody = () => ({ count: 3, travelMs: 1000 });
  f.world.launchBody = mock.fn(async job => {
    assert.ok(job.count <= f.snapshot.budgets.get(job.sourceId)!);
    f.snapshot.budgets.set(job.sourceId, f.snapshot.budgets.get(job.sourceId)! - job.count);
  });
  f.world.syncInventory = async () => {};
  const commander = new Commander(() => {}, () => f.world);
  const run = commander.start('expansion', config);
  t.after(async () => { commander.stop(); t.mock.timers.tick(0); await run; });
  await settle(); t.mock.timers.tick(250); await settle();
  assert.ok(release); assert.ok(commander.states.expansion.work?.plan);
  assert.equal((f.world.launchBody as any).mock.callCount(), 1);
  release(); await settle();
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(1200); await settle(); }
  assert.equal((f.world.launchBody as any).mock.callCount(), 1);
  assert.ok(commander.states.expansion.nextScanAt, 'finishing the global draft starts the scan countdown');
});

test('meteorite expiry at its actual dispatch time is skipped with a visible reason', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  delayProposals((_, signal) => paused(signal, () => {}));
  const f = fakeWorld(); f.world.quote = () => null;
  let expiry = 160000;
  f.snapshot.meteorites = [2n, 3n].map(meteoriteId => ({ meteoriteId, positionX: 1, positionY: 0, galaxyId: 1n, probeCount: 1, expiresAt: { toMillis: () => expiry } }));
  f.world.quoteBody = () => ({ count: 3, travelMs: 1000 });
  f.world.launchBody = mock.fn(async () => {});
  const events: string[] = [];
  const commander = new Commander((_, s) => events.push(s.phase), () => f.world);
  const run = commander.start('expansion', config);
  t.after(async () => { commander.stop(); t.mock.timers.tick(0); await run; });
  await settle(); t.mock.timers.tick(250); await settle();
  assert.equal((f.world.launchBody as any).mock.callCount(), 1);
  expiry = Date.now() + 2000;
  t.mock.timers.tick(1200); await settle();
  assert.equal((f.world.launchBody as any).mock.callCount(), 1);
  assert.ok(events.some(s => /跳过陨石 #3.*剩余寿命.*不足航行/.test(s)));
});

test('a source rule change during global planning retains unaffected candidates and completes the round', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  let release!: () => void;
  delayProposals((round, signal) => { if (round === 1) return paused(signal, resume => { release = resume; }); });
  mock.method(FrontierPlanner.prototype, 'steps', function* () { return []; });
  const f = fakeWorld(), peer = planet(3n, 10, 0, true), target = planet(4n, 11, 0);
  f.snapshot.owned.push(peer); f.snapshot.planets.push(peer, target); f.snapshot.budgets.set(3n, 20);
  let changed = false;
  f.world.read = () => ({ ...f.snapshot, quoteVersion: changed ? 'new' : 'old', quoteGlobalVersion: 'global',
    sourceQuoteVersions: new Map([[1n, changed ? 'new-local' : 'old-local'], [3n, 'stable']]) });
  f.world.quote = (source, target) => target === source + 1n ? { count: 12, travelMs: 1000 } : null;
  const commander = new Commander(() => {}, () => f.world);
  const run = commander.start('expansion', config);
  t.after(async () => { commander.stop(); t.mock.timers.tick(0); await run; });
  await settle(); assert.ok(release); changed = true; release(); await settle();
  t.mock.timers.tick(250); await settle();
  const calls = (f.world.launch as any).mock.calls.map((c: any) => c.arguments);
  assert.deepEqual(calls, [[3n, 4n, 12]], 'unaffected source dispatches from the original draft');
  assert.ok(commander.states.expansion.nextScanAt, 'local rule changes cannot keep the round permanently open');
});

test('reinforcements get nearby jobs while the full draft is paused, with no duplicate publication', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  let release!: () => void;
  delayProposals((round, signal) => { if (round === 1) return paused(signal, resume => { release = resume; }); });
  const f = scenario();
  f.snapshot.budgets.set(1n, 0);
  const commander = new Commander(() => {}, () => f.world);
  const run = commander.start('expansion', config); await settle();
  assert.ok(release); assert.ok(commander.states.expansion.work?.plan);
  assert.equal(f.sent.length, 0);
  f.snapshot.budgets.set(1n, 36);
  t.mock.timers.tick(1000); await settle();
  assert.equal(f.sent.length, 1, 'does not wait for global planning or the next scan');
  assert.equal(f.sent[0].target, 2n, 'the nearest affordable target goes first');
  assert.ok(commander.states.expansion.work?.plan);
  for (let i = 0; i < 2; i++) { t.mock.timers.tick(1200); await settle(); }
  assert.deepEqual(f.sent.map(s => s.target), [2n, 3n, 4n]);
  assert.equal(f.snapshot.budgets.get(1n), 0);
  release(); await settle();
  assert.equal(commander.states.expansion.queue.length, 0);
  commander.stop(); await run;
});

test('newly captured sources gain coverage and occupation confirmation while the full draft remains unfinished', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  delayProposals((_, signal) => paused(signal, () => {}));
  const f = scenario(); f.snapshot.budgets.set(1n, 0);
  f.snapshot.identity = 'me';
  let needsScan = false, scans = 0;
  f.world.needsScan = () => needsScan;
  f.world.scan = async () => { scans++; needsScan = false; };
  const commander = new Commander(() => {}, () => f.world);
  const run = commander.start('expansion', config);
  t.after(async () => { commander.stop(); t.mock.timers.tick(0); await run; });
  await settle();
  f.snapshot.budgets.set(1n, 24);
  t.mock.timers.tick(1000); await settle();
  assert.equal(f.sent.length, 1);
  const captured = f.snapshot.planets.find(p => p.planetId === f.sent[0].target)!;
  captured.ownerId = f.source.ownerId;
  f.snapshot.owned.push(captured); f.snapshot.budgets.set(captured.planetId, 20);
  needsScan = true;
  t.mock.timers.tick(250); await settle();
  assert.equal(scans, 2, 'new coverage does not wait for the full proposal round');
  assert.ok(commander.states.expansion.work?.plan);
  assert.equal(commander.states.expansion.captured, 1);
  assert.equal(commander.states.expansion.ownedCount, 2);
  commander.stop(); await run;
});

test('occupation changes in subscribed memory update counters without a new subscription or completed draft', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  delayProposals((_, signal) => paused(signal, () => {}));
  const f = scenario(); f.snapshot.budgets.set(1n, 0); f.snapshot.identity = 'me';
  const commander = new Commander(() => {}, () => f.world);
  const run = commander.start('expansion', config);
  t.after(async () => { commander.stop(); t.mock.timers.tick(0); await run; });
  await settle();
  f.snapshot.budgets.set(1n, 24); t.mock.timers.tick(1000); await settle();
  const captured = f.snapshot.planets.find(p => p.planetId === f.sent[0].target)!;
  captured.ownerId = f.source.ownerId; f.snapshot.owned.push(captured);
  t.mock.timers.tick(1000); await settle();
  assert.equal(commander.states.expansion.captured, 1);
  assert.equal((f.world.scan as any).mock.callCount(), 1);
  assert.ok(commander.states.expansion.work?.plan);
  commander.stop(); await run;
});

test('slow frontline quotes still publish and dispatch when background-priority planning is starved', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  delayProposals((_, signal) => paused(signal, () => {}));
  const original = (globalThis as any).scheduler;
  const background = t.mock.fn(() => new Promise<void>(() => {}));
  Object.assign(globalThis, { scheduler: { postTask: background } });
  t.after(() => { Object.assign(globalThis, { scheduler: original }); });
  const f = scenario(); f.snapshot.budgets.set(1n, 0);
  const commander = new Commander(() => {}, () => f.world);
  const run = commander.start('expansion', config); await settle();
  let cpu = 0; t.mock.method(performance, 'now', () => cpu);
  f.world.quote = () => { cpu += 10; return { count: 12, travelMs: 1000 }; };
  f.snapshot.budgets.set(1n, 36);
  t.mock.timers.tick(1000); await settle();
  for (let i = 0; i < 8; i++) { t.mock.timers.tick(0); await settle(); }
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].target, 2n);
  assert.ok(commander.states.expansion.work?.plan, 'the full draft is still unfinished');
  assert.ok(commander.states.expansion.work?.frontierTiming?.computeMs! >= 30);
  assert.equal(background.mock.callCount(), 0, 'frontline slices do not depend on background scheduling');
  commander.stop(); t.mock.timers.tick(0); await run;
});

test('a reinforcement draft cannot spend reservations from the other lane or existing expansion jobs', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  delayProposals((_, signal) => paused(signal, () => {}));
  const f = scenario(); f.snapshot.budgets.set(1n, 0);
  const commander = new Commander(() => {}, () => f.world);
  const run = commander.start('expansion', config); await settle();
  // Model an independently planned attack without dispatching it in this test.
  (commander as unknown as { attackReservations: Map<bigint, number> }).attackReservations.set(1n, 24);
  f.snapshot.budgets.set(1n, 48);
  t.mock.timers.tick(1000); await settle();
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(1200); await settle(); }
  assert.equal(f.sent.length, 2); assert.equal(f.snapshot.budgets.get(1n), 24);
  assert.equal(new Set(f.sent.map(s => s.target)).size, 2);
  commander.stop(); await run;
});

test('stop cancels a sliced frontier draft before it can publish or dispatch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  delayProposals((_, signal) => paused(signal, () => {}));
  const f = scenario(); f.snapshot.budgets.set(1n, 0);
  const commander = new Commander(() => {}, () => f.world);
  const run = commander.start('expansion', config); await settle();
  let clock = 0; t.mock.method(performance, 'now', () => clock);
  f.world.quote = () => { clock += 10; return { count: 12, travelMs: 1000 }; };
  f.snapshot.budgets.set(1n, 100);
  t.mock.timers.tick(1000); await settle();
  assert.notEqual(commander.states.expansion.work?.frontier, undefined);
  commander.stop(); t.mock.timers.tick(0); await run;
  assert.equal(f.sent.length, 0); assert.equal(commander.states.expansion.queue.length, 0);
});

test('new nearby captures displace maintenance and precede a retained distant capture without reallocating it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  delayProposals((_, signal) => paused(signal, () => {}));
  const f = scenario(); f.snapshot.budgets.set(1n, 0);
  const commander = new Commander(() => {}, () => f.world);
  const run = commander.start('expansion', config); await settle();
  const distant = { sourceId: 1n, targetId: 50n, count: 12, travelMs: 100000 };
  commander.states.expansion.queue = [distant, { sourceId: 1n, targetId: 1n, kind: 'upgrade', count: 100, travelMs: 0 }];
  f.snapshot.budgets.set(1n, 100);
  const internal = commander as unknown as { configs: { expansion: typeof config }; updateFrontier(config: typeof config, signal: AbortSignal): Promise<void> };
  await internal.updateFrontier(internal.configs.expansion, new AbortController().signal);
  assert.deepEqual(commander.states.expansion.queue.map(job => job.targetId), [2n, 3n, 4n, 50n]);
  assert.equal(commander.states.expansion.queue.at(-1), distant, 'retained allocation stays intact');
  commander.stop(); await run;
});

function scenario() {
  const f = fakeWorld();
  f.snapshot.planets = [f.source, ...Array.from({ length: 50 }, (_, i) => planet(BigInt(i + 2), i + 1, 0))];
  f.snapshot.budgets.set(1n, 1000);
  const sent: { target: bigint; at: number }[] = [];
  f.world.launch = async (source, target, count) => {
    assert.ok(count <= f.snapshot.budgets.get(source)!);
    f.snapshot.budgets.set(source, f.snapshot.budgets.get(source)! - count);
    sent.push({ target, at: Date.now() });
  };
  f.world.syncInventory = async () => {};
  return { ...f, sent };
}

test('a slow coverage scan preserves the queue and continues the 1.2-second dispatch cadence', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = scenario(); let finish!: () => void, scans = 0;
  f.world.scan = async () => { if (++scans === 2) await new Promise<void>(resolve => { finish = resolve; }); };
  const commander = new Commander(() => {}, () => f.world);
  const run = commander.start('expansion', config); await settle();
  for (let i = 0; i < 10; i++) { t.mock.timers.tick(1200); await settle(); }
  assert.equal(scans, 2); assert.ok(finish); assert.equal(commander.states.expansion.nextScanAt, null);
  assert.equal(f.sent.length, 11); assert.equal(commander.states.expansion.queue.length, 39);
  for (let i = 0; i < 10; i++) { t.mock.timers.tick(1200); await settle(); }
  assert.equal(f.sent.length, 21); assert.equal(scans, 2);
  assert.deepEqual(f.sent.map(s => s.at), Array.from({ length: 21 }, (_, i) => 100000 + i * 1200));
  finish(); await settle();
  assert.equal(commander.states.expansion.nextScanAt, 134000, 'countdown starts after the background plan completes');
  commander.stop(); await run;
});

test('supplementary coverage preserves the active draft and its countdown even when it completes mid-scan', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  let release!: () => void, releaseCoverage!: () => void, rounds = 0, needs = false, scans = 0;
  delayProposals((round, signal) => { rounds = round; if (round === 1) return paused(signal, resume => { release = resume; }); });
  const f = scenario();
  f.world.needsScan = () => needs;
  f.world.scan = async () => { needs = false; if (++scans === 2) await new Promise<void>(resolve => { releaseCoverage = resolve; }); };
  const commander = new Commander(() => {}, () => f.world), run = commander.start('expansion', config);
  t.after(async () => { releaseCoverage?.(); commander.stop(); t.mock.timers.tick(0); await run; });
  await settle(); assert.ok(release);
  const started = commander.states.expansion.work?.plan?.startedAt;
  needs = true; t.mock.timers.tick(250); await settle();
  assert.equal(scans, 2); assert.ok(releaseCoverage); assert.equal(rounds, 1);
  assert.equal(commander.states.expansion.work?.plan?.startedAt, started);
  release(); await settle();
  const deadline = commander.states.expansion.nextScanAt;
  assert.equal(deadline, 110250, 'completion starts countdown while supplemental coverage is still loading');
  releaseCoverage(); await settle();
  assert.equal(commander.states.expansion.nextScanAt, deadline, 'coverage completion must not erase the countdown');
  needs = true; t.mock.timers.tick(250); await settle();
  assert.equal(scans, 3); assert.equal(rounds, 1, 'new source coverage does not force another full draft');
  assert.equal(commander.states.expansion.nextScanAt, deadline);
});

test('frontier coalitions dispatch through one native batch while the full draft remains paused', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  delayProposals((_, signal) => paused(signal, () => {}));
  const f = fakeWorld(), ally = planet(3n, 0, 1, true);
  f.snapshot.owned.push(ally); f.snapshot.planets.push(ally); f.target.probeCount = 644;
  f.snapshot.budgets = new Map([[1n, 435], [3n, 230]]); f.snapshot.attackMultiplierUpperBound = 1;
  f.world.quote = () => null; f.world.route = () => ({ travelMs: 10000, lossPct: 0 });
  const batch = mock.fn(async (job: import('../src/features/expansion/types').Assignment) => {
    for (const m of members(job)) f.snapshot.budgets.set(m.sourceId, f.snapshot.budgets.get(m.sourceId)! - m.count);
  });
  f.world.launchGroup = batch; f.world.syncInventory = async () => {};
  const commander = new Commander(() => {}, () => f.world);
  const run = commander.start('expansion', { ...config, settings: { ...config.settings, maxSources: 3 } });
  t.after(async () => { commander.stop(); t.mock.timers.tick(0); await run; });
  await settle(); t.mock.timers.tick(2000); await settle();
  assert.ok(commander.states.expansion.work?.plan, 'global plan remains unfinished');
  assert.equal(batch.mock.callCount(), 1); assert.equal((f.world.launch as any).mock.callCount(), 0);
  assert.equal(members(batch.mock.calls[0].arguments[0]).length, 2);
  t.mock.timers.tick(5000); await settle();
  assert.equal(batch.mock.callCount(), 1, 'in-flight target cannot be submitted twice');
});

test('frontier coalition publication rechecks every supporting source against live stock', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  delayProposals((_, signal) => paused(signal, () => {}));
  const f = fakeWorld(), ally = planet(3n, 0, 1, true);
  f.snapshot.owned.push(ally); f.snapshot.planets.push(ally); f.target.probeCount = 150;
  f.snapshot.budgets = new Map([[1n, 100], [3n, 100]]); f.snapshot.attackMultiplierUpperBound = 1;
  f.world.quote = () => null; f.world.route = () => ({ travelMs: 10000, lossPct: 0 });
  const batch = mock.fn(async () => {}); f.world.launchGroup = batch;
  const original = FrontierPlanner.prototype.steps;
  let drafted = false;
  mock.method(FrontierPlanner.prototype, 'steps', function*(this: FrontierPlanner, ...args: Parameters<typeof original>) {
    const jobs = yield* original.apply(this, args);
    const donor = jobs[0]?.support?.[0];
    if (donor) { drafted = true; f.snapshot.budgets.set(donor.sourceId, 0); }
    return jobs;
  });
  const commander = new Commander(() => {}, () => f.world);
  const run = commander.start('expansion', { ...config, settings: { ...config.settings, maxSources: 3 } });
  t.after(async () => { commander.stop(); t.mock.timers.tick(0); await run; });
  await settle(); t.mock.timers.tick(2000); await settle();
  assert.ok(drafted); assert.equal(batch.mock.callCount(), 0);
  assert.deepEqual(commander.states.expansion.queue, [], 'an invalid support contribution rejects the whole batch before publication');
});

test('slow planning does not stop dispatch; its late result merges with remaining jobs and live inventory', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  let release!: () => void;
  delayProposals((round, signal) => { if (round === 2) return paused(signal, resume => { release = resume; }); });
  const f = scenario();
  const commander = new Commander(() => {}, () => f.world);
  const run = commander.start('expansion', config); await settle();
  for (let i = 0; i < 10; i++) { t.mock.timers.tick(1200); await settle(); }
  assert.ok(release); const before = f.sent.length;
  for (let i = 0; i < 10; i++) { t.mock.timers.tick(1200); await settle(); }
  assert.equal(f.sent.length, before + 10);
  // A concurrent manual spend is visible only in the live cache. The old draft
  // must not restore already dispatched targets or spend its obsolete budget.
  f.snapshot.budgets.set(1n, 36);
  release(); await settle();
  const queue = commander.states.expansion.queue;
  assert.ok(queue.reduce((n, job) => n + members(job).reduce((sum, m) => sum + m.count, 0), 0) <= 36);
  assert.ok(queue.every(job => !f.sent.some(sent => sent.target === job.targetId)));
  for (let i = 0; i < 5; i++) { t.mock.timers.tick(1200); await settle(); }
  assert.equal(new Set(f.sent.map(s => s.target)).size, f.sent.length);
  commander.stop(); await run;
});

test('stop cancels a waiting planner and discards its queued result without dispatch or leaking the lock', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  let release!: () => void;
  delayProposals((_, signal) => paused(signal, resume => { release = resume; }));
  const f = scenario(), commander = new Commander(() => {}, () => f.world);
  const run = commander.start('expansion', config); await settle();
  assert.ok(release); commander.stop(); await run;
  release(); await settle(); assert.equal(f.sent.length, 0);
  assert.equal((f.world.dispose as any).mock.callCount(), 1);
});

function sunScenario() {
  const f = scenario();
  Object.assign(f.snapshot, { identity: 'me', allies: new Set(['me']), intelligence: true, fleets: [], automated: new Set(),
    suns: [], meteorites: [], bodyFleets: new Map() });
  f.snapshot.budgets.set(1n, 2000);
  f.world.routeBody = () => ({ travelMs: 1000, lossPct: 0 });
  f.world.quoteBody = () => ({ count: 700, travelMs: 1000 });
  const sunSends: number[] = [];
  f.world.launchBody = async job => {
    assert.ok(job.count <= f.snapshot.budgets.get(job.sourceId)!);
    f.snapshot.budgets.set(job.sourceId, f.snapshot.budgets.get(job.sourceId)! - job.count);
    sunSends.push(Date.now());
    f.snapshot.suns![0].ownerId = { toHexString: () => 'me' };
  };
  const addSun = () => { f.snapshot.suns = [{ sunId: 999n, positionX: 2, positionY: 0, galaxyId: 1n, probeCount: 0 }]; };
  return { ...f, sunSends, addSun };
}

test('slow background rounds publish and eventually dispatch an affordable sun while ordinary sends keep advancing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  let rounds = 0;
  delayProposals((round, signal) => {
    rounds = round;
    if (round > 1) return paused(signal, release => { setTimeout(release, 2500); });
  });
  const f = sunScenario(), commander = new Commander(() => {}, () => f.world);
  const run = commander.start('expansion', config); await settle(); f.addSun();
  for (let i = 0; i < 160; i++) { t.mock.timers.tick(250); await settle(); }
  assert.ok(rounds >= 3); assert.ok(f.sent.length > 20);
  assert.equal(commander.states.expansion.queue.filter(job => job.targetKind === 'sun').length + f.sunSends.length, 1);
  for (let i = 0; i < 160; i++) { t.mock.timers.tick(250); await settle(); }
  assert.equal(f.sunSends.length, 1, 'new refills cannot push the retained sun indefinitely behind ordinary jobs');
  commander.stop(); t.mock.timers.tick(3000); await run;
});

for (const change of ['inventory', 'ownership', 'garrison'] as const) {
  test(`a queued sun invalidated by ${change} releases only its own reserve while ordinary expansion continues`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
    localStorage.setItem('swarm-helper-last-operation-v1', '100000');
    const f = sunScenario(); f.addSun();
    const commander = new Commander(() => {}, () => f.world);
    const run = commander.start('expansion', { ...config, settings: { ...config.settings, intervalMs: 1500 } }); await settle();
    assert.ok(commander.states.expansion.queue.some(job => job.targetKind === 'sun'));
    if (change === 'inventory') f.snapshot.budgets.set(1n, 600);
    if (change === 'ownership') f.snapshot.suns![0].ownerId = { toHexString: () => 'other' };
    if (change === 'garrison') f.snapshot.suns![0].probeCount++;
    for (let i = 0; i < 20; i++) { t.mock.timers.tick(250); await settle(); }
    assert.ok(f.sent.length > 0, 'ordinary capture still gets dispatch slots');
    if (change !== 'garrison') assert.equal(f.sunSends.length, 0);
    assert.ok(commander.states.expansion.queue.reduce((n, job) => n + job.count, 0) <= f.snapshot.budgets.get(1n)!);
    commander.stop(); await run;
  });
}

test('cancelling a superseded sun wait cannot clear the replacement sun reservation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  localStorage.setItem('swarm-helper-last-operation-v1', '100000');
  const f = sunScenario(); f.addSun();
  let needsScan = false;
  f.world.needsScan = () => needsScan;
  f.world.scan = async () => { needsScan = false; };
  const commander = new Commander(() => {}, () => f.world);
  const run = commander.start('expansion', { ...config, settings: { ...config.settings, candidates: 1 } }); await settle();
  assert.equal(commander.states.expansion.queue[0].targetKind, 'sun');
  f.snapshot.suns![0].ownerId = { toHexString: () => 'other' };
  f.snapshot.suns!.push({ sunId: 1000n, positionX: 3, positionY: 0, galaxyId: 1n, probeCount: 0 });
  needsScan = true; t.mock.timers.tick(1000); await settle();
  assert.ok(commander.states.expansion.queue.some(job => job.targetKind === 'sun' && job.targetId === 1000n));
  assert.equal((commander as any).logisticsReservations.get(1n), 700, 'the old waiting task must not release the replacement plan\'s budget');
  t.mock.timers.tick(1200); await settle();
  assert.equal(f.sunSends.length, 1);
  commander.stop(); await run;
});
