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
  assert.equal(settings.peacefulDevelopment, 0); assert.equal(settings.intervalMs, 1200); assert.equal(settings.radius, 64); assert.equal(settings.cautiousExpansion, 0);
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

test('sun discovery funds the 3-garrison sun before two nearer expensive suns and keeps launched supply attached', () => {
  const f = specialWorld();
  const donor = planet(4n, -1, 0, true);
  f.snapshot.owned.push(donor); f.snapshot.planets = [...f.snapshot.owned];
  f.snapshot.budgets = new Map([[1n, 50], [4n, 2100]]);
  const cheap = { ...sun(30n, 3), positionX: 15 };
  f.snapshot.suns = [sun(19n, 19), { ...sun(18n, 18), positionX: 3 }, cheap];
  f.world.quoteBody = () => null;
  const planner = new SunPlanner();
  const plan = () => finishPlanning(planner.steps(f.world, f.snapshot, config(), f.snapshot.budgets, new Set()));
  // Only the lead has a launch route. Recruit the actual gap from the donor.
  f.world.routeBody = source => source === 1n ? { travelMs: 15000, lossPct: 0 } : null;
  const first = plan();
  assert.equal(first.job?.sunId, cheap.sunId); assert.equal(first.state?.required, 400); assert.equal(first.job?.count, 350);
  planner.launched(first.job!, f.snapshot);
  f.snapshot.suns.push(sun(31n, 0));
  const waiting = plan();
  assert.equal(waiting.sun, cheap.sunId); assert.equal(waiting.state?.incoming, 350); assert.equal(waiting.job, undefined);
});

test('sun discovery compares ordinary probe prices including conversion and loss, and skips blocked routes', () => {
  const f = specialWorld(), cheap = sun(3n, 3), expensive = sun(19n, 19);
  f.snapshot.suns = [cheap, expensive]; f.snapshot.budgets.set(1n, 5000);
  const plan = (locked = new Set<string>()) => finishPlanning(new SunPlanner().steps(f.world, f.snapshot, config(), f.snapshot.budgets, locked));
  f.world.routeBody = (_hub, id) => ({ travelMs: 1000, lossPct: id === 3n ? 90 : 0 });
  f.world.quoteBody = (_hub, id) => ({ travelMs: 1000, count: id === 3n ? 4000 : 2000 });
  assert.equal(plan().job?.targetId, 19n);
  f.world.quoteBody = (_hub, id) => ({ travelMs: 1000, count: id === 3n ? 380 : 2000 });
  assert.equal(plan().job?.targetId, 3n);
  assert.equal(plan(new Set(['sun:3'])).job?.targetId, 19n);
  f.world.routeBody = (_hub, id) => id === 3n ? null : { travelMs: 1000, lossPct: 0 };
  assert.equal(plan().job?.targetId, 19n);
});

test('a cheap sun with no viable supply does not block a fundable alternative', () => {
  const f = specialWorld(), rich = planet(8n, 8, 0, true);
  f.snapshot.owned.push(rich); f.snapshot.planets = [...f.snapshot.owned];
  f.snapshot.budgets = new Map([[1n, 50], [8n, 2000]]);
  f.snapshot.suns = [sun(3n, 3), sun(19n, 19)];
  f.world.routeBody = (hub, id) => (hub === 1n && id === 3n || hub === 8n && id === 19n) ? { travelMs: 1000, lossPct: 0 } : null;
  f.world.quoteBody = (hub, id) => hub === 8n && id === 19n ? { travelMs: 1000, count: 2000 } : null;
  f.world.route = () => null;
  const planner = new SunPlanner();
  const plan = () => finishPlanning(planner.steps(f.world, f.snapshot, config(), f.snapshot.budgets, new Set()));
  const unfunded = plan();
  assert.equal(unfunded.job, undefined); assert.equal(unfunded.reservations.size, 0);
  assert.equal(plan().job?.targetId, 19n);
});

test('large sun searches retain a cheaper reachable hub beyond the first bounded route window', () => {
  const f = specialWorld(), planner = new SunPlanner();
  f.snapshot.owned = Array.from({ length: 546 }, (_, i) => planet(BigInt(100 + i), 0, 0, true));
  f.snapshot.planets = [...f.snapshot.owned]; f.snapshot.budgets = new Map(f.snapshot.owned.map(p => [p.planetId, 2000]));
  f.snapshot.suns = [sun(19n, 19), { ...sun(3n, 3), positionX: 15 }];
  const route = mock.fn((source: bigint, target: bigint) =>
    target === 3n && source < 120n ? null : { travelMs: 1000, lossPct: 0 });
  f.world.routeBody = route; f.world.quoteBody = (_source, target) => ({ travelMs: 1000, count: target === 3n ? 400 : 2000 });
  const plan = () => finishPlanning(planner.steps(f.world, f.snapshot, config(), f.snapshot.budgets, new Set()));
  assert.equal(plan().job, undefined); assert.equal(route.mock.callCount(), 16);
  assert.equal(plan().job?.targetId, 3n); assert.equal(route.mock.callCount(), 32);
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
  assert.equal(plan.job.targetId, 4n, 'the nearest viable hub is retained');
  assert.equal(members(plan.job).reduce((n, m) => n + m.count, 0), 40);
  assert.equal(members(plan.job).length, 2, 'logistics is independent of the direct-attack source cap');
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

function upgradeWorld(size: number) {
  const f = specialWorld();
  f.snapshot.owned = Array.from({ length: size }, (_, i) => ({ ...planet(BigInt(i + 1), i, 0, true), level: 1 }));
  f.snapshot.planets = [...f.snapshot.owned];
  f.snapshot.budgets = new Map(f.snapshot.owned.map(p => [p.planetId, 200]));
  f.world.syncInventory = mock.fn(async () => {});
  return f;
}

test('planned upgrades use native batches of 200, one interval per batch, and aggregate verified results', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = upgradeWorld(205), batches: { ids: bigint[]; at: number }[] = [], phases: string[] = [];
  f.world.upgrade = mock.fn(async () => { assert.fail('must not downgrade bulk to individual requests'); });
  f.world.upgradeMany = async ids => {
    batches.push({ ids, at: Date.now() });
    for (const id of ids) { f.snapshot.owned.find(p => p.planetId === id)!.level = 2; f.snapshot.budgets.set(id, 100); }
  };
  const commander = new Commander((_mode, state) => { if (phases.at(-1) !== state.phase) phases.push(state.phase); }, () => f.world);
  const run = commander.start('expansion', config()); await settle();
  t.mock.timers.tick(600000); await settle();
  assert.equal(batches.length, 1); assert.equal(batches[0].ids.length, 200);
  assert.equal(commander.states.expansion.metrics!.upgrades, 200);
  t.mock.timers.tick(250); await settle();
  t.mock.timers.tick(1250); await settle();
  assert.deepEqual(batches.map(batch => batch.ids.length), [200, 5]);
  assert.ok(batches[1].at - batches[0].at >= 1500);
  assert.equal(new Set(batches.flatMap(batch => batch.ids)).size, 205);
  assert.equal(commander.states.expansion.metrics!.upgrades, 205);
  assert.equal(commander.states.expansion.sent, 0); assert.equal(commander.states.expansion.captured, 0);
  assert.deepEqual((f.world.syncInventory as any).mock.calls.map((call: any) => call.arguments[0].length), [200, 5]);
  assert.ok(phases.some(phase => phase.includes('200/200')));
  commander.stop(); await run;
});

test('bulk upgrade revalidates each member after waiting and counts only observed level increases', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = upgradeWorld(4); let submitted: bigint[] = []; const phases: string[] = [];
  f.world.upgradeMany = async ids => { submitted = ids; f.snapshot.owned.find(p => p.planetId === ids[0])!.level = 2; };
  const commander = new Commander((_mode, state) => phases.push(state.phase), () => f.world), run = commander.start('expansion', config()); await settle();
  localStorage.setItem('swarm-helper-last-operation-v1', '700000');
  t.mock.timers.tick(600000); await settle();
  assert.equal(commander.states.expansion.queue.length, 4);
  f.snapshot.budgets.set(2n, 0);
  f.snapshot.owned.find(p => p.planetId === 3n)!.level = 2;
  t.mock.timers.tick(1500); await settle();
  assert.deepEqual(submitted, [1n, 4n]);
  assert.equal(commander.states.expansion.metrics!.upgrades, 1);
  assert.ok(phases.some(phase => /1\/2.*未确认/.test(phase)));
  commander.stop(); await run;
});

test('stopping during the batch interval cancels all unsubmitted upgrades', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = upgradeWorld(3); f.world.upgradeMany = mock.fn(async () => {});
  const commander = new Commander(() => {}, () => f.world), run = commander.start('expansion', config()); await settle();
  localStorage.setItem('swarm-helper-last-operation-v1', '700000');
  t.mock.timers.tick(600000); await settle();
  assert.equal(commander.states.expansion.queue.length, 3);
  commander.stop(); await run;
  assert.equal((f.world.upgradeMany as any).mock.callCount(), 0);
  assert.equal(commander.states.expansion.queue.length, 0);
});

test('a rejected bulk upgrade is neither split nor repeated at the same observed levels', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = upgradeWorld(3);
  f.world.upgradeMany = mock.fn(async () => { throw new Error('batch rejected'); });
  f.world.upgrade = mock.fn(async () => {});
  const commander = new Commander(() => {}, () => f.world), run = commander.start('expansion', config()); await settle();
  t.mock.timers.tick(600000); await settle();
  t.mock.timers.tick(10000); await settle();
  assert.equal((f.world.upgradeMany as any).mock.callCount(), 1);
  assert.equal((f.world.upgrade as any).mock.callCount(), 0);
  assert.equal(commander.states.expansion.metrics!.upgrades, 0);
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
  f.world.launchGroup = mock.fn(async job => { for (const m of members(job)) f.snapshot.budgets.set(m.sourceId, f.snapshot.budgets.get(m.sourceId)! - m.count); });
  f.world.syncInventory = async () => {};
  const commander = new Commander(() => {}, () => f.world), run = commander.start('expansion', config()); await settle();
  const supply = (f.world.launchGroup as any).mock.calls[0].arguments[0];
  assert.equal(supply.targetId, 1n); assert.deepEqual(members(supply).map(m => [m.sourceId, m.count]), [[3n, 40]]);
  t.mock.timers.tick(1500); await settle();
  assert.deepEqual((f.world.launch as any).mock.calls[0].arguments, [3n, 2n, 3]);
  assert.equal((f.world.launchBody as any).mock.callCount(), 0);
  f.snapshot.budgets.set(1n, 100);
  t.mock.timers.tick(1500); await settle();
  assert.equal((f.world.launchBody as any).mock.callCount(), 1);
  assert.equal((f.world.launchBody as any).mock.calls[0].arguments[0].count, 100);
  commander.stop(); await run;
});


test('peaceful development uses auto-upgrading sources, waits for meteorites and restores expansion after restart', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  t.mock.method(Math, 'random', () => 0.5);
  const f = specialWorld(), cfg = config();
  cfg.settings.peacefulDevelopment = 1;
  cfg.settings.captureMeteorites = 0; // A saved expansion preference must not disable this mode.
  f.snapshot.autoUpgrading = new Set(f.snapshot.owned.map(p => p.planetId));
  cfg.settings.upgradeStable = 0;
  f.snapshot.suns = [sun()]; f.snapshot.budgets.set(1n, 500);
  f.world.quoteBody = (_source, _target, kind) => ({ count: kind === 'sun' ? 100 : 3, travelMs: 1000 });
  f.world.syncInventory = async () => {};
  const commander = new Commander(() => {}, () => f.world);
  let run = commander.start('expansion', cfg);
  try {
    await settle();
    for (let i = 0; i < 4; i++) { t.mock.timers.tick(1000); await settle(); }
    assert.equal(commander.states.expansion.running, true);
    assert.equal(commander.states.expansion.queue.length, 0);
    assert.equal((f.world.launch as any).mock.callCount(), 0);
    assert.equal((f.world.launchBody as any).mock.callCount(), 0);
    f.snapshot.meteorites = [meteorite()];
    for (let i = 0; i < 8; i++) { t.mock.timers.tick(1000); await settle(); }
    const calls = (f.world.launchBody as any).mock.calls;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].arguments[0].targetKind, 'comet');
    assert.equal((f.world.launch as any).mock.callCount(), 0);
    assert.equal((f.world.launchGroup as any).mock.callCount(), 0);
    assert.equal(cfg.settings.captureMeteorites, 0, 'runtime overrides preserve saved settings');
    commander.stop(); await run;
    f.snapshot.meteorites = [];
    run = commander.start('expansion', config()); await settle();
    for (let i = 0; i < 5; i++) { t.mock.timers.tick(1000); await settle(); }
    assert.ok((f.world.launchBody as any).mock.calls.some((call: any) => call.arguments[0].targetKind === 'sun'));
    assert.ok((f.world.launch as any).mock.callCount() > 0);
  } finally { commander.stop(); await run; }
});

test('peaceful upgrades ignore excluded planets but reserve nearby meteorite opportunities', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const f = specialWorld(), cfg = config(), upgrades = new StableUpgrades();
  cfg.settings.peacefulDevelopment = 1; cfg.settings.captureSuns = 0;
  f.snapshot.budgets.set(1n, 500);
  assert.equal(expansionProposals(f.world, f.snapshot, cfg, f.snapshot.budgets, new Set()).edges.length, 0);
  upgrades.observe(f.snapshot, cfg); t.mock.timers.tick(cfg.settings.stableMs);
  assert.equal(upgrades.plans(f.snapshot, cfg, f.snapshot.budgets, new Set()).length, 1);
  f.snapshot.meteorites = [meteorite()];
  assert.equal(upgrades.plans(f.snapshot, cfg, f.snapshot.budgets, new Set()).length, 0);
  f.snapshot.meteorites = []; cfg.settings.upgradeStable = 0;
  assert.equal(upgrades.plans(f.snapshot, cfg, f.snapshot.budgets, new Set()).length, 0);
});


test('native auto-upgrading sources do not receive duplicate helper upgrades', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const f = specialWorld(), cfg = config(), upgrades = new StableUpgrades();
  f.snapshot.planets = [f.source]; f.snapshot.budgets.set(1n, 500);
  upgrades.observe(f.snapshot, cfg); t.mock.timers.tick(cfg.settings.stableMs);
  assert.equal(upgrades.plans(f.snapshot, cfg, f.snapshot.budgets, new Set()).length, 1);
  f.snapshot.autoUpgrading = new Set([1n]);
  assert.equal(upgrades.eligible(f.source, f.snapshot, cfg), false, 'queued upgrades are rejected too');
  assert.equal(upgrades.plans(f.snapshot, cfg, f.snapshot.budgets, new Set()).length, 0);
});
