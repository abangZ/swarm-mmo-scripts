import './helpers/browser';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Meteorite, Sun } from '../src/game/types';
import { defaults, jobKey, members, type Assignment } from '../src/features/expansion/types';
import { defaultPolicy, type ModeConfig } from '../src/features/commander/types';
import { expansionProposals } from '../src/features/expansion/proposals';
import { expansionPlanSteps, planExpansion } from '../src/features/expansion/planner';
import { meteoriteProposals, SunPlanner } from '../src/features/expansion/special-targets';
import { ExpansionJournal, StableUpgrades, validSpecialTarget } from '../src/features/expansion/strategy';
import { finishPlanning } from '../src/runtime/planning';
import { Commander } from '../src/features/commander/engine';
import { loadSettings, parseSettings } from '../src/app/settings';
import { fakeWorld, planet, settle, identity } from './helpers/fixtures';

const config = (): ModeConfig => ({ settings: { ...defaults }, policy: { ...defaultPolicy, frontlinePercent: 0 } });
function specialWorld() {
  const f = fakeWorld();
  Object.assign(f.snapshot, { identity: 'me', allies: new Set(['me']), intelligence: true, automated: new Set(), fleets: [], bodyFleets: new Map(), suns: [], meteorites: [] });
  f.source.level = 1;
  f.world.route = () => ({ travelMs: 1000, lossPct: 0 });
  f.world.routeBody = () => ({ travelMs: 2000, lossPct: 0 });
  f.world.launchBody = mock.fn(async () => {});
  f.world.launchGroup = mock.fn(async () => {});
  return f;
}
const sun = (id = 2n, count = 0): Sun => ({ sunId: id, positionX: 2, positionY: 0, galaxyId: 1n, probeCount: count });
const meteorite = (id = 2n, expires = Date.now() + 3600000): Meteorite => ({ meteoriteId: id, positionX: 2, positionY: 0, galaxyId: 1n, probeCount: 1, expiresAt: { toMillis: () => expires } });

test('old settings preserve expansion speed and migrate independent economy, special targets and stable upgrades', () => {
  localStorage.setItem('swarm-helper-expansion-settings', JSON.stringify({ scanMs: 30000, intervalMs: 1200, candidates: 8, radius: 64, horizonMs: 120000, maxTravelMs: 1800000, reserve: 0, maxSources: 10 }));
  const settings = parseSettings(loadSettings());
  assert.equal(settings.intervalMs, 1200); assert.equal(settings.radius, 64); assert.equal(settings.cautiousExpansion, 0);
  assert.equal(settings.captureSuns, 1); assert.equal(settings.captureMeteorites, 1); assert.equal(settings.upgradeStable, 1);
  assert.equal(settings.economicHorizonMs, 10800000); assert.equal(settings.stableMs, 600000);
});

test('economic value survives a journey longer than the queue window and does not replace capture-count priority', () => {
  const f = fakeWorld(); f.target.level = 3; f.world.quote = () => ({ count: 3, travelMs: 300000 });
  const plan = expansionProposals(f.world, f.snapshot, config(), f.snapshot.budgets, new Set());
  assert.ok(plan.edges[0].value! > 0);
  const edges: Assignment[] = [{ sourceId: 1n, targetId: 2n, count: 3, travelMs: 1000, value: 1 },
    { sourceId: 1n, targetId: 3n, count: 3, travelMs: 1000, value: 1 }, { sourceId: 1n, targetId: 4n, count: 6, travelMs: 500, value: 99999 }];
  assert.equal(planExpansion(edges, new Map([[1n, 6]]), 1000, 120000, 1800000).jobs.length, 2);
});

test('fast expansion accepts exposed neutral opportunities; cautious mode explains why it skips them', () => {
  const f = specialWorld(); f.target.positionX = 20;
  const enemy = planet(9n, 21, 0); enemy.ownerId = { toHexString: () => 'enemy' }; f.snapshot.planets.push(enemy);
  const fast = expansionProposals(f.world, f.snapshot, config(), f.snapshot.budgets, new Set());
  assert.equal(fast.edges.length, 1); assert.equal(fast.exposed, 1);
  const cautious = config(); cautious.settings.cautiousExpansion = 1;
  const safe = expansionProposals(f.world, f.snapshot, cautious, f.snapshot.budgets, new Set());
  assert.equal(safe.edges.length, 0); assert.match(safe.sources[0].reason, /孤立目标/);
});

test('a narrow enemy watch radius does not hide friendly support within eight tiles', () => {
  const f = specialWorld(), cfg = config(); f.target.positionX = 6;
  const enemy = planet(9n, 7, 0); enemy.ownerId = { toHexString: () => 'enemy' }; f.snapshot.planets.push(enemy);
  cfg.settings.cautiousExpansion = 1; cfg.policy.threatRadius = 2;
  const plan = expansionProposals(f.world, f.snapshot, cfg, f.snapshot.budgets, new Set());
  assert.equal(plan.edges.length, 1); assert.equal(plan.exposed, 0);
});

test('planet and meteorite ids do not collide; expiry is checked against the actual queue position', () => {
  const now = Date.now();
  const planetJob: Assignment = { sourceId: 1n, targetId: 2n, count: 3, travelMs: 100 };
  const comet: Assignment = { sourceId: 1n, targetId: 2n, targetKind: 'comet', count: 3, travelMs: 200, expiresAt: now + 10000 };
  const both = planExpansion([planetJob, comet], new Map([[1n, 6]]), 1000, 120000, 1800000);
  assert.equal(both.jobs.length, 2); assert.notEqual(jobKey(both.jobs[0]), jobKey(both.jobs[1]));
  comet.expiresAt = now + 6000;
  const delayed = finishPlanning(expansionPlanSteps([comet], new Map([[1n, 6]]), 1000, 120000, 1800000, 1500));
  assert.equal(delayed.jobs.length, 0);
});

test('meteorites require known expiry, no competing fleet and a reachable arrival; expiry is rechecked at dispatch', () => {
  const f = specialWorld(); f.snapshot.meteorites = [meteorite(), meteorite(3n, Date.now() + 500), meteorite(4n, NaN)];
  f.world.quoteBody = () => ({ count: 3, travelMs: 1000 });
  const jobs = finishPlanning(meteoriteProposals(f.world, f.snapshot, config(), f.snapshot.budgets, new Set()));
  assert.deepEqual(jobs.map(j => j.targetId), [2n]);
  assert.equal(validSpecialTarget(jobs[0], f.snapshot, config()), true);
  f.snapshot.meteorites[0] = meteorite(2n, Date.now() + 500);
  assert.equal(validSpecialTarget(jobs[0], f.snapshot, config()), false);
  f.snapshot.bodyFleets!.set('comet:2', [{ id: 1n, owner: 'enemy', target: 2n, count: null, arriving: null, arrival: null }]);
  assert.equal(finishPlanning(meteoriteProposals(f.world, f.snapshot, config(), f.snapshot.budgets, new Set())).length, 0);
});

test('an affordable neutral sun uses its native whole-super-probe quote and remains inside the fixed zone', () => {
  const f = specialWorld(); f.snapshot.suns = [sun()]; f.snapshot.budgets.set(1n, 120);
  f.world.quoteBody = () => ({ count: 100, travelMs: 2000 });
  const planner = new SunPlanner();
  const result = finishPlanning(planner.steps(f.world, f.snapshot, config(), f.snapshot.budgets, new Set()));
  assert.equal(result.job!.targetKind, 'sun'); assert.equal(result.job!.count, 100); assert.equal(result.reservations.get(1n), 100);
  const regional = config(); regional.policy.zone = { x: 0, y: 0, radius: 1 };
  assert.equal(finishPlanning(planner.steps(f.world, f.snapshot, regional, f.snapshot.budgets, new Set())).job, undefined);
  assert.equal(finishPlanning(planner.steps(f.world, f.snapshot, config(), f.snapshot.budgets, new Set(['sun:2']))).job, undefined);
});

test('60 + 60 probes gather to one friendly planet, wait for real inventory, then attack the sun once', () => {
  const f = specialWorld(); f.snapshot.planets = [f.source];
  const donor = planet(3n, 0, 1, true); f.snapshot.owned.push(donor); f.snapshot.planets.push(donor);
  f.snapshot.budgets = new Map([[1n, 60], [3n, 60]]); f.snapshot.suns = [sun()];
  f.world.quoteBody = source => (f.snapshot.budgets.get(source) ?? 0) >= 100 ? { count: 100, travelMs: 2000 } : null;
  const planner = new SunPlanner(), cfg = config();
  const plan = finishPlanning(planner.steps(f.world, f.snapshot, cfg, f.snapshot.budgets, new Set()));
  assert.equal(plan.job!.kind, 'sun-supply'); assert.equal(plan.job!.targetId, 1n); assert.equal(plan.job!.count, 40);
  assert.equal(plan.reservations.get(1n), 60); assert.equal(plan.reservations.get(3n), 40);
  planner.launched(plan.job!);
  const waiting = finishPlanning(planner.steps(f.world, f.snapshot, cfg, f.snapshot.budgets, new Set()));
  assert.equal(waiting.job, undefined); assert.equal(waiting.reservations.get(1n), 60);
  f.snapshot.budgets.set(1n, 100); f.snapshot.budgets.set(3n, 20);
  const ready = finishPlanning(planner.steps(f.world, f.snapshot, cfg, f.snapshot.budgets, new Set()));
  assert.equal(ready.job!.targetKind, 'sun'); assert.equal(ready.job!.count, 100);
  assert.equal(ready.job!.sourceId, 1n);
});

test('sun gathering covers garrison and both legs of loss, and never starts an underfunded campaign', () => {
  const f = specialWorld(); f.snapshot.planets = [f.source];
  const donor = planet(3n, 0, 1, true); f.snapshot.owned.push(donor); f.snapshot.planets.push(donor);
  f.snapshot.suns = [sun(2n, 1)]; f.snapshot.budgets = new Map([[1n, 300], [3n, 200]]);
  f.world.quoteBody = () => null; f.world.routeBody = () => ({ travelMs: 2000, lossPct: 50 }); f.world.route = () => ({ travelMs: 1000, lossPct: 50 });
  const planner = new SunPlanner();
  const result = finishPlanning(planner.steps(f.world, f.snapshot, config(), f.snapshot.budgets, new Set()));
  assert.equal(result.job!.targetId, 1n); assert.equal(result.job!.count, 200);
  f.snapshot.budgets.set(3n, 199);
  const insufficient = finishPlanning(planner.steps(f.world, f.snapshot, config(), f.snapshot.budgets, new Set()));
  assert.equal(insufficient.job, undefined); assert.equal(insufficient.reservations.size, 0);
});

test('small nearby donors do not consume the source limit and hide an affordable sun', () => {
  const f = specialWorld(), small = planet(3n, 1, 0, true), strong = planet(4n, 2, 0, true);
  f.snapshot.owned.push(small, strong); f.snapshot.planets = [...f.snapshot.owned]; f.snapshot.suns = [sun()];
  f.snapshot.budgets = new Map([[1n, 60], [3n, 1], [4n, 60]]);
  f.world.quoteBody = () => null;
  f.world.route = (source, target) => ({ travelMs: source === 3n || target === 3n ? 1000 : 2000, lossPct: 0 });
  const cfg = config(); cfg.settings.maxSources = 2;
  const plan = finishPlanning(new SunPlanner().steps(f.world, f.snapshot, cfg, f.snapshot.budgets, new Set()));
  assert.equal(plan.job?.kind, 'sun-supply');
  assert.equal(plan.job.targetId, 1n); assert.equal(plan.job.sourceId, 4n); assert.equal(plan.job.count, 40);
  assert.equal(members(plan.job).length, 1);
});

test('sun gathering accounts for a stricter overlapping mode reserve on newly arriving supply', () => {
  const f = specialWorld(), donor = planet(3n, 0, 1, true);
  f.snapshot.planets = [f.source, donor]; f.snapshot.owned.push(donor); f.snapshot.suns = [sun()];
  f.snapshot.budgets = new Map([[1n, 60], [3n, 80]]); f.world.quoteBody = () => null;
  f.world.routeBody = source => ({ travelMs: source === 1n ? 2000 : 5000, lossPct: 0 });
  const spendable = new Map([[1n, 45], [3n, 80]]), planner = new SunPlanner();
  const result = finishPlanning(planner.steps(f.world, f.snapshot, config(), spendable, new Set(), () => 25));
  assert.equal(result.job!.targetId, 1n); assert.equal(result.job!.count, 74);
  assert.ok(Math.floor((60 + result.job!.count) * 0.75) >= 100);
});

test('enemy pressure, a changed sun or native automation invalidates a queued sun supply', () => {
  const f = specialWorld(); const donor = planet(3n, 0, 1, true);
  f.snapshot.planets = [f.source, donor]; f.snapshot.owned.push(donor); f.snapshot.suns = [sun()];
  const planner = new SunPlanner();
  const job: Assignment = { sourceId: 3n, targetId: 1n, count: 40, travelMs: 1000, kind: 'sun-supply', sunId: 2n, garrison: 0 };
  assert.equal(planner.validSupply(job, f.snapshot, config()), true);
  f.snapshot.automated!.add(1n); assert.equal(planner.validSupply(job, f.snapshot, config()), false); f.snapshot.automated!.clear();
  f.snapshot.suns[0].probeCount = 1; assert.equal(planner.validSupply(job, f.snapshot, config()), false); f.snapshot.suns[0].probeCount = 0;
  const enemy = planet(9n, 1, 1); enemy.ownerId = { toHexString: () => 'enemy' }; f.snapshot.planets.push(enemy);
  assert.equal(planner.validSupply(job, f.snapshot, config()), false);
});

test('stable upgrades protect expansion opportunities, all task reservations and the payback horizon', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const f = specialWorld(), cfg = config(), upgrades = new StableUpgrades();
  f.snapshot.planets = [f.source]; f.snapshot.budgets.set(1n, 500);
  assert.equal(upgrades.plans(f.snapshot, cfg, f.snapshot.budgets, new Set()).length, 0);
  t.mock.timers.tick(600000);
  const plan = upgrades.plans(f.snapshot, cfg, f.snapshot.budgets, new Set());
  assert.equal(plan.length, 1); assert.equal(plan[0].kind, 'upgrade'); assert.equal(plan[0].count, 100);
  assert.equal(upgrades.plans(f.snapshot, cfg, f.snapshot.budgets, new Set([1n])).length, 0);
  f.snapshot.planets.push(f.target); assert.equal(upgrades.plans(f.snapshot, cfg, f.snapshot.budgets, new Set()).length, 0); f.snapshot.planets.pop();
  f.snapshot.suns = [sun()]; assert.equal(upgrades.plans(f.snapshot, cfg, f.snapshot.budgets, new Set()).length, 0); f.snapshot.suns = [];
  f.source.level = 2; assert.equal(upgrades.plans(f.snapshot, cfg, f.snapshot.budgets, new Set()).length, 0, '400-minute base payback exceeds 3 hours');
  f.source.level = 1; upgrades.launched(plan[0]);
  assert.equal(upgrades.plans(f.snapshot, cfg, f.snapshot.budgets, new Set()).length, 0, 'a delayed or unknown upgrade is not repeated at the same observed level');
});

test('incoming fleets and reconnect reset the stable-upgrade observation period', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const f = specialWorld(), cfg = config(), upgrades = new StableUpgrades(); f.snapshot.planets = [f.source]; f.snapshot.budgets.set(1n, 200);
  upgrades.observe(f.snapshot, cfg); t.mock.timers.tick(600000);
  f.snapshot.fleets = [{ id: 9n, owner: 'enemy', target: 1n, count: null, arriving: null, arrival: null }];
  assert.equal(upgrades.plans(f.snapshot, cfg, f.snapshot.budgets, new Set()).length, 0);
  f.snapshot.fleets = []; assert.equal(upgrades.plans(f.snapshot, cfg, f.snapshot.budgets, new Set()).length, 0);
  t.mock.timers.tick(600000); assert.equal(upgrades.plans(f.snapshot, cfg, f.snapshot.budgets, new Set()).length, 1);
  upgrades.reset(); assert.equal(upgrades.plans(f.snapshot, cfg, f.snapshot.budgets, new Set()).length, 0);
});

test('capture metrics wait for confirmed ownership and measure continuous retention, excluding meteorite expiry', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const f = specialWorld(), journal = new ExpansionJournal(); f.target.level = 3; f.target.ownerId = identity; f.snapshot.owned.push(f.target);
  const job: Assignment = { sourceId: 1n, targetId: 2n, count: 3, travelMs: 1000 };
  journal.sent(job); assert.equal(journal.snapshot().planets, 0);
  journal.captured(job, f.snapshot); journal.captured({ ...job, targetKind: 'comet' }, f.snapshot);
  assert.equal(journal.snapshot().addedBaseProduction, 3);
  t.mock.timers.tick(1800000); journal.observe(f.snapshot);
  assert.deepEqual(journal.snapshot().retention30, { held: 1, total: 1 });
  f.snapshot.owned = [f.source]; journal.observe(f.snapshot); f.snapshot.owned.push(f.target);
  t.mock.timers.tick(1800000); journal.observe(f.snapshot);
  assert.deepEqual(journal.snapshot().retention60, { held: 0, total: 1 });
});

test('commander prioritizes one affordable sun, then expands to planet and meteorite with the same raw id without overspending', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 }); t.mock.method(Math, 'random', () => 0.5);
  const f = specialWorld(); f.snapshot.budgets.set(1n, 106); f.snapshot.suns = [sun()]; f.snapshot.meteorites = [meteorite()];
  const sent: Assignment[] = [];
  f.world.quote = () => ({ count: 3, travelMs: 1000 });
  f.world.quoteBody = (_source, _target, kind) => ({ count: kind === 'sun' ? 100 : 3, travelMs: 1000 });
  f.world.launchBody = async job => { sent.push(job); f.snapshot.budgets.set(1n, f.snapshot.budgets.get(1n)! - job.count); };
  f.world.launch = async (sourceId, targetId, count) => { sent.push({ sourceId, targetId, count, travelMs: 1000 }); f.snapshot.budgets.set(1n, f.snapshot.budgets.get(1n)! - count); };
  f.world.syncInventory = async () => {};
  const commander = new Commander(() => {}, () => f.world), run = commander.start('expansion', config()); await settle();
  for (let i = 0; i < 6; i++) { t.mock.timers.tick(500); await settle(); }
  assert.equal(sent[0].targetKind, 'sun'); assert.equal(sent.length, 3);
  assert.equal(new Set(sent.map(jobKey)).size, 3); assert.equal(f.snapshot.budgets.get(1n), 0);
  f.target.ownerId = identity; f.snapshot.owned.push(f.target); f.snapshot.suns[0].ownerId = identity; f.snapshot.meteorites[0].ownerId = identity;
  t.mock.timers.tick(10000); await settle();
  assert.equal(commander.states.expansion.captured, 3); assert.equal(commander.states.expansion.metrics!.suns, 1); assert.equal(commander.states.expansion.metrics!.meteorites, 1);
  commander.stop(); await run;
});

test('commander upgrades a stable rear planet once, synchronizes its inventory and does not count an upgrade as a capture or fleet', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 }); t.mock.method(Math, 'random', () => 0.5);
  const f = specialWorld(); f.snapshot.planets = [f.source]; f.snapshot.budgets.set(1n, 200);
  f.world.upgrade = mock.fn(async id => { assert.equal(id, 1n); f.source.level = 2; f.snapshot.budgets.set(1n, 100); });
  f.world.syncInventory = mock.fn(async () => {});
  const commander = new Commander(() => {}, () => f.world), run = commander.start('expansion', config()); await settle();
  assert.equal((f.world.upgrade as any).mock.callCount(), 0);
  t.mock.timers.tick(600000); await settle();
  assert.equal((f.world.upgrade as any).mock.callCount(), 1);
  assert.equal((f.world.syncInventory as any).mock.callCount(), 1);
  assert.equal(commander.states.expansion.sent, 0); assert.equal(commander.states.expansion.captured, 0);
  assert.equal(commander.states.expansion.metrics!.upgrades, 1);
  t.mock.timers.tick(600000); await settle();
  assert.equal((f.world.upgrade as any).mock.callCount(), 1);
  commander.stop(); await run;
});

test('commander completes a fragment-to-sun campaign while continuing ordinary expansion from donor leftovers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 }); t.mock.method(Math, 'random', () => 0.5);
  const f = specialWorld(), donor = planet(3n, 0, 1, true); f.snapshot.owned.push(donor); f.snapshot.planets.push(donor);
  f.snapshot.budgets = new Map([[1n, 60], [3n, 60]]); f.snapshot.suns = [sun(5n)];
  f.world.quote = () => ({ count: 3, travelMs: 1000 });
  f.world.quoteBody = id => (f.snapshot.budgets.get(id) ?? 0) >= 100 ? { count: 100, travelMs: 1000 } : null;
  f.world.launch = mock.fn(async (source, target, count) => { f.snapshot.budgets.set(source, f.snapshot.budgets.get(source)! - count); });
  f.world.syncInventory = async () => {};
  const commander = new Commander(() => {}, () => f.world), run = commander.start('expansion', config()); await settle();
  assert.deepEqual((f.world.launch as any).mock.calls[0].arguments, [3n, 1n, 40]);
  t.mock.timers.tick(1500); await settle();
  assert.deepEqual((f.world.launch as any).mock.calls[1].arguments, [3n, 2n, 3]);
  assert.equal((f.world.launchBody as any).mock.callCount(), 0);
  f.snapshot.budgets.set(1n, 100);
  t.mock.timers.tick(1500); await settle();
  assert.equal((f.world.launchBody as any).mock.callCount(), 1);
  assert.equal((f.world.launchBody as any).mock.calls[0].arguments[0].count, 100);
  commander.stop(); await run;
});
