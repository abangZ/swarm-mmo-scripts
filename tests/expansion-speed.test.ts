import './helpers/browser';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '../src/features/expansion/types';
import { ExpansionEngine } from '../src/features/expansion/engine';
import { expansionProposals, expansionQuote } from '../src/features/expansion/proposals';
import { planExpansion } from '../src/features/expansion/planner';
import { defaultPolicy } from '../src/features/commander/types';
import { loadSettings } from '../src/app/settings';
import { fakeWorld, planet, settle } from './helpers/fixtures';

test('rear planets with 8, 8, 9, 9 and 12 probes all launch despite journeys exceeding the 120-second planning window', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fakeWorld();
  f.snapshot.planets = []; f.snapshot.owned = []; f.snapshot.budgets.clear();
  for (const [i, stock] of [8, 8, 9, 9, 12].entries()) {
    const source = planet(BigInt(i + 10), 20 + i, 10, true); source.probeCount = stock;
    const target = planet(BigInt(i + 100), i, 0); target.probeCount = 5;
    f.snapshot.planets.push(source, target); f.snapshot.owned.push(source); f.snapshot.budgets.set(source.planetId, stock);
  }
  f.world.route = source => ({ travelMs: 180000 + Number(source) * 1000, lossPct: 0 });
  f.world.quote = source => ({ count: 7, travelMs: f.world.route!(source, 100n)!.travelMs });
  f.world.syncInventory = async () => {};
  f.world.launch = mock.fn(async (source, _target, count) => { f.snapshot.budgets.set(source, f.snapshot.budgets.get(source)! - count); });
  const engine = new ExpansionEngine(() => {}, () => f.world);
  const run = engine.start({ ...defaults, radius: 64, horizonMs: 120000, maxSources: 1 }); await settle();
  assert.equal(engine.state.planning?.assigned, 5);
  for (let i = 0; i < 4; i++) { t.mock.timers.tick(1500); await settle(); }
  const calls = (f.world.launch as any).mock.calls.map((c: any) => c.arguments);
  assert.deepEqual([...new Set(calls.map((c: any[]) => c[0]))].sort(), [10n, 11n, 12n, 13n, 14n]);
  assert.equal(calls.length, 5); assert.equal(new Set(calls.map((c: any[]) => c[1])).size, 5);
  assert.equal(engine.state.flights, 5);
  engine.stop(); t.mock.timers.tick(500); await run;
});

test('rapid expansion sends short trips first and prefers earlier capture over a higher value or cheaper slow route', () => {
  const budgets = new Map([[1n, 10], [2n, 10]]);
  const short = { sourceId: 1n, targetId: 3n, count: 5, travelMs: 10000, value: 0 };
  const long = { sourceId: 2n, targetId: 4n, count: 5, travelMs: 240000, value: 100 };
  assert.deepEqual(planExpansion([long, short], budgets, 1500, 120000, 1800000).jobs.map(j => j.targetId), [3n, 4n]);
  const alternative = { ...short, sourceId: 2n, count: 1, travelMs: 90000, value: 100 };
  assert.equal(planExpansion([alternative, short], budgets, 1500, 120000, 1800000).jobs[0].sourceId, 1n);
  assert.equal(planExpansion([long], budgets, 1500, 120000, 180000).jobs.length, 0, 'the separate journey cap still applies');
});

test('candidate slots are backfilled after unaffordable neighbors, and diagnostics explain the actual journey cap', () => {
  const f = fakeWorld(); f.snapshot.budgets.set(1n, 8); f.target.probeCount = 100;
  const cheap = planet(3n, 3, 0); cheap.probeCount = 2; f.snapshot.planets.push(cheap);
  f.world.quote = (_source, id) => ({ count: id === 2n ? 102 : 4, travelMs: id === 2n ? 1000 : 180000 });
  f.world.route = (_source, id) => ({ travelMs: id === 2n ? 1000 : 180000, lossPct: 0 });
  const config = { settings: { ...defaults, candidates: 1, maxSources: 1 }, policy: { ...defaultPolicy } };
  const proposals = expansionProposals(f.world, f.snapshot, config, f.snapshot.budgets, new Set());
  assert.deepEqual(proposals.edges.map(j => j.targetId), [3n]);
  assert.equal(proposals.readySources, 1);
  config.settings.maxTravelMs = 100000;
  assert.equal(expansionQuote(f.world, f.snapshot, f.source, cheap, config), null);
  f.snapshot.planets = [f.source, cheap];
  const blocked = expansionProposals(f.world, f.snapshot, config, f.snapshot.budgets, new Set());
  assert.match(blocked.sources[0].reason, /180 秒.*100 秒/);
  assert.equal(blocked.sources[0].available, 8);
});

test('receipt and inventory synchronization consume the interval instead of adding another full interval', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fakeWorld(); f.snapshot.budgets.set(1n, 100); f.snapshot.planets.push(planet(3n, 2, 0));
  const times: number[] = [];
  f.world.launch = async () => { times.push(Date.now()); await new Promise(resolve => setTimeout(resolve, 500)); };
  f.world.syncInventory = async () => { await new Promise(resolve => setTimeout(resolve, 500)); };
  const engine = new ExpansionEngine(() => {}, () => f.world);
  const run = engine.start(defaults); await settle();
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(500); await settle(); }
  assert.deepEqual(times, [100000, 101500]);
  engine.stop(); t.mock.timers.tick(500); await run;
});

test('new sources request coverage immediately rather than waiting for the periodic scan', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fakeWorld(); f.snapshot.budgets.set(1n, 0);
  let needsScan = false;
  f.world.needsScan = () => needsScan;
  f.world.scan = mock.fn(async () => { if (needsScan) f.snapshot.budgets.set(1n, 20); needsScan = false; });
  const engine = new ExpansionEngine(() => {}, () => f.world);
  const run = engine.start({ ...defaults, scanMs: 120000 }); await settle();
  needsScan = true; t.mock.timers.tick(250); await settle();
  assert.equal((f.world.scan as any).mock.callCount(), 2);
  assert.equal((f.world.launch as any).mock.callCount(), 1);
  engine.stop(); t.mock.timers.tick(500); await run;
});

test('old 64-radius / 120-second preferences migrate without keeping the accidental arrival deadline', () => {
  const { maxTravelMs: _missing, ...old } = { ...defaults, radius: 64, horizonMs: 120000 };
  localStorage.setItem('swarm-helper-expansion-settings', JSON.stringify(old));
  const form = loadSettings();
  assert.equal(form.radius, '64'); assert.equal(form.horizonMs, '120'); assert.equal(form.maxTravelMs, '1800');
});

test('dense neighborhoods stop quoting once enough feasible choices are found', () => {
  const f = fakeWorld(); f.snapshot.budgets.set(1n, 1000);
  f.snapshot.planets = [f.source, ...Array.from({ length: 200 }, (_, i) => planet(BigInt(i + 2), 1 + i % 10, 1 + Math.floor(i / 10)))];
  const quote = mock.fn(() => ({ count: 4, travelMs: 3000 })); f.world.quote = quote;
  const config = { settings: { ...defaults, candidates: 10, maxSources: 1 }, policy: { ...defaultPolicy } };
  const result = expansionProposals(f.world, f.snapshot, config, f.snapshot.budgets, new Set());
  assert.equal(result.edges.length, 10);
  assert.equal(quote.mock.callCount(), 20, 'the backfill limit must not become compulsory work for dense viable areas');
});
