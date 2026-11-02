import './helpers/browser';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { bestCandidates } from '../src/shared/best-candidates';
import { PlanetIndex } from '../src/shared/planet-index';
import { subscriptionBatches } from '../src/game/subscription-batches';
import { runPlanning } from '../src/runtime/planning';
import { expansionProposals, expansionProposalSteps } from '../src/features/expansion/proposals';
import { planExpansion, expansionPlanSteps } from '../src/features/expansion/planner';
import { defaults, members } from '../src/features/expansion/types';
import { defaultPolicy, type ModeConfig } from '../src/features/commander/types';
import { Commander } from '../src/features/commander/engine';
import { withControl, unresolved } from '../src/runtime/operations';
import { fakeWorld, planet, settle } from './helpers/fixtures';

const config = (): ModeConfig => ({ settings: { ...defaults, radius: 64 }, policy: { ...defaultPolicy, frontlinePercent: 0 } });

test('bounded selection exactly matches stable full sorting, including ties and interleaved candidate backfill', () => {
  const items = Array.from({ length: 4000 }, (_, i) => ({ id: i, x: i % 64 - 32, y: Math.floor(i / 64) - 32, stock: i % 8 + 1, level: i % 10 + 1 }));
  const ranks = [(p: typeof items[0]) => p.x ** 2 + p.y ** 2, (p: typeof items[0]) => p.stock, (p: typeof items[0]) => -p.level / (p.stock + 2), (p: typeof items[0]) => -(p.id % 11)];
  for (const limit of [0, 1, 32, 80, 400, 5000]) {
    const full = ranks.map(rank => [...items].sort((a, b) => rank(a) - rank(b)));
    const bounded = ranks.map(rank => bestCandidates(items, limit, rank));
    for (let i = 0; i < ranks.length; i++) assert.deepEqual(bounded[i], full[i].slice(0, limit));
    const pool = (orders: typeof items[]) => {
      const picked = new Map<number, typeof items[0]>();
      for (let i = 0; picked.size < limit && i < items.length; i++) for (const order of orders) if (order[i] && picked.size < limit) picked.set(order[i].id, order[i]);
      return [...picked.keys()];
    };
    assert.deepEqual(pool(bounded), pool(full));
  }
});

test('shared static ranks preserve local query tie ordering across cell boundaries and negative coordinates', () => {
  const targets = Array.from({ length: 2000 }, (_, i) => { const p = planet(BigInt(i), i * 37 % 200 - 100, i * 53 % 180 - 90); p.probeCount = i % 7; return p; });
  const index = new PlanetIndex(targets);
  const ranked = bestCandidates(index.ordered(), targets.length, p => p.probeCount);
  for (const x of [-65, -32, -1, 0, 32, 65]) for (const radius of [1, 32, 64]) {
    const source = planet(10000n, x, -32);
    const near = index.near(source, radius);
    const filtered = ranked.filter(p => (p.positionX - source.positionX) ** 2 + (p.positionY - source.positionY) ** 2 <= radius ** 2);
    assert.deepEqual(filtered.slice(0, 80), [...near].sort((a, b) => a.probeCount - b.probeCount).slice(0, 80));
    assert.deepEqual(new Set(near), new Set(targets.filter(p => Math.hypot(p.positionX - x, p.positionY + 32) <= radius)));
  }
});

test('cooperative planning retains all 420 sources and identical target assignments and budgets', async () => {
  const f = fakeWorld();
  f.snapshot.owned = Array.from({ length: 420 }, (_, i) => planet(BigInt(i + 1), i % 21 - 10, Math.floor(i / 21) - 10, true));
  f.snapshot.planets = [...f.snapshot.owned, ...Array.from({ length: 500 }, (_, i) => planet(BigInt(i + 1000), i % 40 - 20, Math.floor(i / 40) - 6))];
  f.snapshot.budgets = new Map(f.snapshot.owned.map(p => [p.planetId, 40]));
  f.world.route = () => ({ travelMs: 3000, lossPct: 0 });
  const settings = config();
  const sync = expansionProposals(f.world, f.snapshot, settings, f.snapshot.budgets, new Set());
  let resumes = 0;
  const async = await runPlanning(expansionProposalSteps(f.world, f.snapshot, settings, f.snapshot.budgets, new Set()), () => true, () => resumes++, async () => {}, 0);
  assert.deepEqual(async, sync); assert.equal(async!.sources.length, 420); assert.equal(async!.readySources, 420); assert.ok(resumes >= 420);
  const expected = planExpansion(sync.edges, f.snapshot.budgets, 1500, 120000, 1800000);
  const actual = await runPlanning(expansionPlanSteps(async!.edges, f.snapshot.budgets, 1500, 120000, 1800000), () => true, undefined, async () => {}, 0);
  assert.deepEqual(actual, expected);
  const spent = new Map<bigint, number>();
  for (const job of actual!.jobs) for (const member of members(job)) spent.set(member.sourceId, (spent.get(member.sourceId) ?? 0) + member.count);
  for (const [id, count] of spent) assert.ok(count <= f.snapshot.budgets.get(id)!);
});

test('a cancelled planning slice closes its generator and does not refresh quotes or publish its result', async () => {
  let active = true, closed = false, advanced = false;
  function* steps() { try { yield; advanced = true; return 42; } finally { closed = true; } }
  const resume = mock.fn();
  assert.equal(await runPlanning(steps(), () => active, resume, async () => { active = false; }, 0), undefined);
  assert.equal(closed, true); assert.equal(advanced, false); assert.equal(resume.mock.callCount(), 0);
});

test('stopping during a planning yield cancels all unsent work and releases the shared lock', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  let time = 0; t.mock.method(performance, 'now', () => time += 10);
  const f = fakeWorld();
  const commander = new Commander(() => {}, () => f.world);
  const run = commander.start('expansion', config()); await settle();
  assert.equal((f.world.launch as any).mock.callCount(), 0);
  commander.stop(); t.mock.timers.tick(0); await run;
  assert.equal((f.world.launch as any).mock.callCount(), 0);
  assert.equal((f.world.dispose as any).mock.callCount(), 1);
  await withControl(async () => {});
});

test('adding attack during a planning yield discards expansion results and reserves the shared inventory before replanning', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  let time = 0; t.mock.method(performance, 'now', () => time += 10);
  const f = fakeWorld(), enemy = planet(9n, 2, 0); enemy.ownerId = { toHexString: () => 'a'.repeat(64) }; enemy.level = 1;
  Object.assign(f.snapshot, { identity: 'me', allies: new Set(['me']), intelligence: true, fleets: [], automated: new Set() });
  f.snapshot.planets.push(enemy); f.snapshot.budgets.set(1n, 28); f.source.level = 10;
  f.world.route = () => ({ travelMs: 1000, lossPct: 0 });
  const commander = new Commander(() => {}, () => f.world);
  const run = commander.start('expansion', config()); await settle();
  const attack = config(); attack.policy.zone = { x: 0, y: 0, radius: 10 };
  commander.start('attack', attack);
  t.mock.method(performance, 'now', () => 0); t.mock.timers.tick(0); await settle();
  t.mock.timers.tick(250); await settle();
  assert.deepEqual((f.world.launch as any).mock.calls.map((c: any) => c.arguments), [[1n, 9n, 24]]);
  commander.stop(); t.mock.timers.tick(500); await run;
  assert.equal(unresolved(), false);
});

test('quote refresh failure cancels dispatch and leaves expansion available for automatic recovery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  let time = 0; t.mock.method(performance, 'now', () => time += 10);
  const f = fakeWorld(); f.world.refreshQuotes = () => { throw new Error('subscription lost'); };
  const commander = new Commander(() => {}, () => f.world);
  const run = commander.start('expansion', config());
  const attack = config(); attack.policy.zone = { x: 0, y: 0, radius: 10 };
  Object.assign(f.snapshot, { intelligence: true, allies: new Set(['me']) });
  commander.start('attack', attack); await settle(); t.mock.timers.tick(250); await settle(); t.mock.timers.tick(0); await settle();
  assert.equal((f.world.launch as any).mock.callCount(), 0);
  assert.equal(commander.states.expansion.activity, 'paused'); assert.equal(commander.states.attack.running, false);
  commander.stop(); t.mock.timers.tick(500); await run;
  assert.equal(unresolved(), false);
});

test('the completed queue waits on the limiter without re-planning and still respects inventory at transmission', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fakeWorld(); f.snapshot.budgets.set(1n, 100); f.snapshot.planets.push(planet(3n, 2, 0));
  const quotes = mock.fn(f.world.quote); f.world.quote = quotes;
  const commander = new Commander(() => {}, () => f.world);
  const run = commander.start('expansion', config()); await settle();
  const initialQuotes = quotes.mock.callCount();
  t.mock.timers.tick(250); await settle();
  assert.equal(quotes.mock.callCount(), initialQuotes, 'the next queued entry does not repeat planning or quotes');
  assert.equal((f.world.launch as any).mock.callCount(), 1);
  f.snapshot.budgets.set(1n, 0);
  t.mock.timers.tick(1250); await settle();
  assert.equal((f.world.launch as any).mock.callCount(), 1, 'inventory changed while queued, so the next launch is cancelled');
  commander.stop(); t.mock.timers.tick(500); await run;
});

test('subscription batches retain full queries on edge growth and stay bounded after repeated growth and shrinkage', () => {
  const keys = Array.from({ length: 117 }, (_, i) => `tile${i}`);
  const original = subscriptionBatches([], keys), saved = structuredClone(original);
  const grown = subscriptionBatches(original, [...keys, ...Array.from({ length: 6 }, (_, i) => `a${i}`)]);
  assert.deepEqual(original, saved, 'planning batches cannot mutate the active subscription generation');
  assert.deepEqual(grown.slice(0, 4), original.slice(0, 4)); assert.equal(grown.length, 6);
  let batches = grown;
  for (let i = 0; i < 80; i++) {
    const wanted = Array.from({ length: 123 - i % 10 }, (_, j) => `tile${j + i}`);
    batches = subscriptionBatches(batches, wanted);
    assert.deepEqual([...batches.flat()].sort(), [...wanted].sort());
    assert.ok(batches.length <= 6); assert.ok(batches.every(b => b.length <= 24));
  }
});
