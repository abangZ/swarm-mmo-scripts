import './helpers/browser';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundPlanner } from '../src/features/expansion/background-planner';
import { expansionProposals } from '../src/features/expansion/proposals';
import { PlanningQuotes } from '../src/features/expansion/planning-quotes';
import { defaults } from '../src/features/expansion/types';
import { defaultPolicy } from '../src/features/commander/types';
import { fakeWorld, planet } from './helpers/fixtures';

function scenario(n = 4) {
  const f = fakeWorld(), planner = new BackgroundPlanner(), cache = new PlanningQuotes();
  f.snapshot.quoteVersion = 'rules'; f.snapshot.attackMultiplierUpperBound = 1;
  f.snapshot.budgets.set(1n, 100);
  f.snapshot.planets = [f.source, ...Array.from({ length: 40 }, (_, i) => planet(BigInt(100 + i), i + 1, 0))];
  f.world.route = () => ({ travelMs: 1000, lossPct: 0 });
  const calls: bigint[] = [];
  f.world.quote = (_source, target) => { calls.push(target); return null; };
  const config = { settings: { ...defaults, candidates: n, maxSources: 1, radius: 64 }, policy: defaultPolicy };
  const plan = (signal = new AbortController().signal, locked = new Set<bigint>()) => planner.proposals(
    cache.begin(f.world, f.snapshot), f.snapshot, config, f.snapshot.budgets, locked, signal, () => true);
  return { ...f, planner, cache, calls, config, plan };
}

test('failed native quotes are bounded, unchanged rounds continue to a farther feasible target', async () => {
  const f = scenario();
  f.world.quote = (_source, target) => { f.calls.push(target); return target === 115n ? { count: 30, travelMs: 1000 } : null; };
  const first = await f.plan();
  assert.equal(f.calls.length, 4); assert.equal(first?.deferredSources, 1); assert.equal(first?.edges.length, 0);
  let found = false;
  for (let i = 0; i < 10 && !found; i++) {
    const before = f.calls.length, result = await f.plan();
    assert.ok(f.calls.length - before <= 8, 'at most n saved candidates plus n new evaluations');
    found = !!result?.edges.some(job => job.targetId === 115n);
  }
  assert.ok(found, 'whole-result memoization must not hide deferred candidates');
  f.snapshot.incoming.add(115n);
  assert.ok(!(await f.plan())?.edges.some(job => job.targetId === 115n), 'saved shortlist does not bypass fleet locks');
});

test('n=1 continues beyond a failed nearest quote, including null routes and deleted cursor targets', async () => {
  const f = scenario(1);
  f.world.route = () => null;
  f.world.quote = (_source, target) => { f.calls.push(target); return target === 105n ? { count: 30, travelMs: 1000 } : null; };
  await f.plan(); assert.deepEqual(f.calls, [100n]);
  f.snapshot.planets = f.snapshot.planets.filter(p => p.planetId !== 101n);
  let found = false;
  for (let i = 0; i < 8 && !found; i++) found = !!(await f.plan())?.edges.some(job => job.targetId === 105n);
  assert.ok(found, 'removed next target cannot trap the cursor on the prefix');
});

test('reinforcement and rules changes restart nearby checks; retained proposals revalidate stock and ownership', async () => {
  const f = scenario(1);
  let available = false;
  f.world.quote = (_source, target) => { f.calls.push(target); return available ? { count: 50, travelMs: 1000 } : null; };
  await f.plan(); await f.plan();
  available = true; f.snapshot.budgets.set(1n, 200);
  assert.equal((await f.plan())?.edges[0]?.targetId, 100n);
  f.snapshot.budgets.set(1n, 49);
  assert.equal((await f.plan())?.edges.length, 0, 'cached successful quote cannot spend unavailable stock');
  f.snapshot.budgets.set(1n, 200); f.snapshot.quoteVersion = 'changed';
  assert.equal((await f.plan())?.edges[0]?.targetId, 100n);
  f.snapshot.planets.find(p => p.planetId === 100n)!.ownerId = f.source.ownerId;
  assert.ok(!(await f.plan())?.edges.some(job => job.targetId === 100n));
});

test('small production increments advance the cursor instead of restarting it', async () => {
  const f = scenario(1);
  for (let i = 0; i < 6; i++) {
    f.snapshot.budgets.set(1n, 100 + i); f.source.probeCount++;
    await f.plan();
  }
  assert.deepEqual(f.calls, [100n, 101n, 102n, 103n, 104n, 105n]);
  f.planner.dispose();
  await f.plan(); assert.equal(f.calls.at(-1), 100n, 'stop/disposal drops all continuation hints');
});

test('a complete affordable shortlist stays cached across natural production', async () => {
  const f = scenario();
  f.world.quote = (_source, target) => { f.calls.push(target); return { count: 30, travelMs: Number(target) }; };
  assert.equal((await f.plan())?.edges.length, 4); assert.equal(f.calls.length, 4);
  f.snapshot.budgets.set(1n, 101); f.source.probeCount++;
  assert.equal((await f.plan())?.edges.length, 4);
  assert.equal(f.calls.length, 4, 'a working shortlist needs no extra native work just because production ticked');
});

test('cancelled drafts cannot advance the committed candidate cursor', async t => {
  const f = scenario(1);
  await f.plan();
  let time = 0, release!: () => void;
  t.mock.method(performance, 'now', () => time);
  t.mock.method((globalThis as any).scheduler, 'postTask', () => new Promise<void>(resolve => { release = resolve; }));
  f.world.quote = (_source, target) => { f.calls.push(target); time += 9; return null; };
  const controller = new AbortController();
  const work = f.plan(controller.signal);
  assert.ok(release); controller.abort(); release(); assert.equal(await work, undefined);
  // Same stock reuses the cancelled read-only quote, but must revisit that target.
  f.world.quote = (_source, target) => { f.calls.push(target); return null; };
  f.cache.clear();
  await f.plan();
  assert.deepEqual(f.calls, [100n, 101n, 101n]);
});

test('3676 optimistic-but-native-infeasible sources bound first-pass quotations without removing sources', async t => {
  const f = scenario(10);
  f.snapshot.owned = Array.from({ length: 3676 }, (_, i) => planet(BigInt(i + 10000), i % 64, Math.floor(i / 64), true));
  f.snapshot.planets = [...f.snapshot.owned, ...Array.from({ length: 160 }, (_, i) => planet(BigInt(i + 20000), i % 16 * 4, Math.floor(i / 16) * 4))];
  f.snapshot.budgets = new Map(f.snapshot.owned.map(p => [p.planetId, 100]));
  f.config.settings.radius = 128;
  let calls = 0; f.world.quote = () => { calls++; return null; };
  const baseline = expansionProposals(f.world, f.snapshot, f.config, f.snapshot.budgets, new Set()), before = calls;
  calls = 0;
  const result = await f.plan();
  assert.equal(result?.sources.length, baseline.sources.length);
  assert.equal(result?.sources.length, 3676);
  assert.equal(result?.deferredSources, 3676);
  assert.equal(calls, 3676 * 10); assert.ok(before >= calls * 8);
  t.diagnostic(`3676 sources, optimistic solo viable but native quote null: ${before} -> ${calls} first-pass quote pairs; deferred candidates continue in later passes (synthetic, not live timing)`);
});
