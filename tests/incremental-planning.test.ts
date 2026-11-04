import './helpers/browser';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { PlanningQuotes } from '../src/features/expansion/planning-quotes';
import { expansionProposals } from '../src/features/expansion/proposals';
import { defaults } from '../src/features/expansion/types';
import { defaultPolicy } from '../src/features/commander/types';
import { Commander } from '../src/features/commander/engine';
import { fakeWorld, planet, settle } from './helpers/fixtures';

const config = { settings: { ...defaults, radius: 48, maxSources: 1 }, policy: defaultPolicy };

test('local influence changes invalidate only affected sources, including previously impossible routes', () => {
  const f = setup(), peer = planet(4n, 0, 1, true);
  f.snapshot.owned.push(peer); f.snapshot.planets.push(peer); f.snapshot.budgets.set(4n, 100);
  f.snapshot.quoteGlobalVersion = 'global';
  f.snapshot.sourceQuoteVersions = new Map([[1n, 'covered'], [4n, 'uncovered']]);
  const quote = mock.fn((source: bigint) => source === 1n ? null : { count: 8, travelMs: 1000 });
  f.world.quote = quote;
  const read = () => { const w = f.cache.begin(f.world, f.snapshot); w.quote(1n, 2n); w.quote(4n, 2n); };
  read(); assert.equal(quote.mock.callCount(), 2);
  f.snapshot.quoteVersion = 'distant-base-changed'; read();
  assert.equal(quote.mock.callCount(), 2, 'unrelated coverage cannot clear native route caches');
  f.snapshot.sourceQuoteVersions.set(1n, 'uncovered'); read();
  assert.equal(quote.mock.callCount(), 3); assert.equal(quote.mock.calls[2].arguments[0], 1n);
  f.snapshot.quoteGlobalVersion = 'new-tech'; read(); assert.equal(quote.mock.callCount(), 5);
});

test('quick quote passes fingerprint only visited sources rather than all 4,000 owned rows', () => {
  const f = setup(); let reads = 0;
  f.snapshot.owned = Array.from({ length: 4000 }, (_, i) => {
    const p = planet(BigInt(i + 10000), 0, 0, true);
    Object.defineProperty(p, 'probeCount', { enumerable: true, get: () => { reads++; return 100; } });
    return p;
  });
  f.snapshot.budgets = new Map(f.snapshot.owned.map(p => [p.planetId, 100]));
  f.cache.begin(f.world, f.snapshot).quote(10000n, 2n);
  assert.equal(reads, 1);
});
function setup() {
  const f = fakeWorld(); f.snapshot.quoteVersion = 'tech-1';
  f.snapshot.budgets.set(1n, 100);
  f.snapshot.planets.push(planet(3n, 2, 0));
  const quote = mock.fn((_source: bigint, target: bigint) => ({ count: Number(target) + 5, travelMs: 1000 }));
  f.world.quote = quote; f.world.route = () => ({ travelMs: 1000, lossPct: 0 });
  const cache = new PlanningQuotes();
  const plan = (locked = new Set<bigint>()) => expansionProposals(cache.begin(f.world, f.snapshot), f.snapshot, config, f.snapshot.budgets, locked);
  return { ...f, cache, quote, plan };
}

test('unchanged neutral routes reuse native work; locks and incoming fleets are still evaluated afresh', () => {
  const f = setup();
  const initial = f.plan(); assert.equal(f.quote.mock.callCount(), 2);
  assert.deepEqual(f.plan(), initial); assert.equal(f.quote.mock.callCount(), 2);
  assert.deepEqual(f.cache.stats, { fresh: 0, reused: 2 });
  assert.deepEqual(f.plan(new Set([2n])).edges.map(j => j.targetId), [3n]);
  f.snapshot.incoming.add(3n);
  assert.equal(f.plan(new Set([2n])).edges.length, 0);
  assert.equal(f.quote.mock.callCount(), 2, 'target locks do not require repeating unchanged native quotes');
});

test('target and rule changes invalidate quotes, while spare inventory preserves successful capture prices', () => {
  const f = setup(); f.plan();
  f.target.probeCount++; f.plan(); assert.equal(f.quote.mock.callCount(), 3);
  const other = planet(4n, 40, 40); f.snapshot.planets.push(other);
  f.plan(); assert.equal(f.quote.mock.callCount(), 3, 'an unrelated distant change cannot invalidate local work');
  f.snapshot.budgets.set(1n, 99); f.plan(); assert.equal(f.quote.mock.callCount(), 3);
  f.snapshot.quoteVersion = 'tech-2'; f.plan(); assert.equal(f.quote.mock.callCount(), 5);
  f.target.ownerId = { toHexString: () => 'enemy' };
  assert.deepEqual(f.plan().edges.map(j => j.targetId), [3n]);
  f.cache.clear(); f.plan(); assert.equal(f.quote.mock.callCount(), 6);
});

test('cached native requirements never bypass changed planning budgets, fleets or enemy freshness', () => {
  const f = setup(); f.plan();
  const available = new Map([[1n, 0]]);
  assert.equal(expansionProposals(f.cache.begin(f.world, f.snapshot), f.snapshot, config, available, new Set()).edges.length, 0);
  f.target.ownerId = { toHexString: () => 'enemy' };
  const wrapped = f.cache.begin(f.world, f.snapshot);
  wrapped.quote(1n, 2n); wrapped.quote(1n, 2n);
  assert.equal(f.quote.mock.callCount(), 4, 'enemy predictions must remain fresh even in the same planning round');
  delete f.snapshot.quoteVersion;
  f.plan(); f.plan(); assert.equal(f.quote.mock.callCount(), 6, 'adapters without a dependency version cannot reuse cross-round quotes');
});

test('insufficient quotes retry on reinforcement and a cheaper current budget never spends a cached capture price', () => {
  const f = setup();
  const native = mock.fn(() => (f.snapshot.budgets.get(1n) ?? 0) >= 50 ? { count: 50, travelMs: 1000 } : null);
  f.world.quote = native;
  f.snapshot.budgets.set(1n, 20); f.plan(); assert.equal(native.mock.callCount(), 2);
  f.snapshot.budgets.set(1n, 100); assert.equal(f.plan().edges.length, 2); assert.equal(native.mock.callCount(), 4);
  f.snapshot.budgets.set(1n, 49); f.source.probeCount = 49;
  assert.equal(f.plan().edges.length, 0); assert.equal(native.mock.callCount(), 4);
  f.source.positionX++;
  f.plan(); assert.equal(native.mock.callCount(), 6, 'geometry changes still require fresh native quotes');
});

test('unknown native routes retry and the cache expires even if adapter dependencies remain unchanged', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const f = setup(); f.world.route = () => null;
  f.plan(); f.plan(); assert.equal(f.quote.mock.callCount(), 2);
  t.mock.timers.tick(5000); f.plan(); assert.equal(f.quote.mock.callCount(), 4);
  f.world.route = () => ({ travelMs: 1000, lossPct: 0 });
  t.mock.timers.tick(5000); f.plan(); assert.equal(f.quote.mock.callCount(), 6);
  t.mock.timers.tick(600000); f.plan(); assert.equal(f.quote.mock.callCount(), 8);
});

test('large empires reuse successful native quotes even when production changes a source inventory', t => {
  const f = setup();
  f.snapshot.owned = Array.from({ length: 1311 }, (_, i) => planet(BigInt(i + 10000), i % 40, Math.floor(i / 40), true));
  f.snapshot.planets = [...f.snapshot.owned, ...Array.from({ length: 566 }, (_, i) => planet(BigInt(i + 20000), i % 40, Math.floor(i / 40)))];
  f.snapshot.budgets = new Map(f.snapshot.owned.map(p => [p.planetId, 100000]));
  const start = process.hrtime.bigint(); f.plan(); const coldMs = Number(process.hrtime.bigint() - start) / 1e6, coldCalls = f.quote.mock.callCount();
  const warm = process.hrtime.bigint(); f.plan(); const warmMs = Number(process.hrtime.bigint() - warm) / 1e6;
  assert.equal(f.quote.mock.callCount(), coldCalls);
  assert.equal(coldCalls, 1311 * config.settings.candidates);
  f.snapshot.budgets.set(10000n, 99999); f.plan();
  assert.equal(f.quote.mock.callCount() - coldCalls, 0);
  t.diagnostic(`1311 sources / 566 targets: cold ${coldCalls} native quotes (${coldMs.toFixed(0)}ms), unchanged 0 quotes (${warmMs.toFixed(0)}ms), one source stock changed 0 quotes; synthetic quotes, not live-game timing`);
});

test('optimistic combat bound skips impossible quotes without removing viable coalitions or deficit top-ups', () => {
  const f = setup();
  f.snapshot.attackMultiplierUpperBound = 2;
  f.snapshot.budgets.set(1n, 2);
  assert.equal(f.plan().edges.length, 0); assert.equal(f.quote.mock.callCount(), 0);
  const ally = { ...planet(4n, 0, 1, true), probeCount: 10 };
  f.snapshot.owned.push(ally); f.snapshot.planets.push(ally); f.snapshot.budgets.set(4n, 30);
  f.world.launchGroup = async () => {};
  const grouped = expansionProposals(f.world, f.snapshot, { ...config, settings: { ...config.settings, maxSources: 2 } }, f.snapshot.budgets, new Set());
  assert.ok(grouped.edges.some(j => j.support?.some(m => m.sourceId === 4n) && j.sourceId === 1n));
  assert.ok(f.quote.mock.callCount() > 0);
  f.snapshot.owned = [f.source]; f.snapshot.identity = 'me';
  f.snapshot.fleets = [{ id: 1n, target: 2n, owner: 'me', count: 20, arriving: 20, arrival: Date.now() }];
  const topup = f.plan();
  assert.ok(topup.edges.some(j => j.targetId === 2n && j.count === 2));
});

test('large weak empires avoid native quotations on the cold pass, retaining every source for diagnostics', t => {
  const f = setup(); f.snapshot.attackMultiplierUpperBound = 1.5;
  f.snapshot.owned = Array.from({ length: 2500 }, (_, i) => planet(BigInt(i + 10000), i % 50, Math.floor(i / 50), true));
  f.snapshot.planets = [...f.snapshot.owned, ...Array.from({ length: 1000 }, (_, i) => ({ ...planet(BigInt(i + 20000), i % 50, Math.floor(i / 50)), probeCount: 500 }))];
  f.snapshot.budgets = new Map(f.snapshot.owned.map(p => [p.planetId, 30]));
  f.world.launchGroup = async () => {};
  const start = process.hrtime.bigint();
  const result = expansionProposals(f.world, f.snapshot, { ...config, settings: { ...config.settings, maxSources: 5 } }, f.snapshot.budgets, new Set());
  assert.equal(result.sources.length, 2500); assert.equal(result.edges.length, 0);
  assert.equal(f.quote.mock.callCount(), 0, 'even five nearby sources cannot defeat these targets');
  t.diagnostic(`2500 sources / 1000 targets / five-source coalitions: ${Number(process.hrtime.bigint() - start) / 1e6}ms, 0 native quotes; synthetic scenario`);
});

test('3676 coalition-dependent sources price n nearby routes rather than 8n+, then reuse routes across production', t => {
  const f = fakeWorld(), cache = new PlanningQuotes();
  f.snapshot.quoteVersion = 'rules'; f.snapshot.attackMultiplierUpperBound = 1;
  f.snapshot.owned = Array.from({ length: 3676 }, (_, i) => planet(BigInt(i + 10000), i % 64, Math.floor(i / 64), true));
  f.snapshot.planets = [...f.snapshot.owned, ...Array.from({ length: 160 }, (_, i) => ({ ...planet(BigInt(i + 20000), i % 16 * 4, Math.floor(i / 16) * 4), probeCount: 300 }))];
  f.snapshot.budgets = new Map(f.snapshot.owned.map(p => [p.planetId, 100]));
  f.world.launchGroup = async () => {};
  const route = mock.fn(() => ({ travelMs: 10000, lossPct: 0 }));
  const quote = mock.fn((source: bigint) => f.snapshot.budgets.get(source)! >= 302 ? { count: 302, travelMs: 10000 } : null);
  f.world.route = route; f.world.quote = quote;
  const cfg = { settings: { ...defaults, radius: 128, candidates: 10, maxSources: 5 }, policy: defaultPolicy };
  const plan = () => expansionProposals(cache.begin(f.world, f.snapshot), f.snapshot, cfg, f.snapshot.budgets, new Set());
  const started = process.hrtime.bigint(), cold = plan(), coldCalls = quote.mock.callCount();
  assert.equal(cold.sources.length, 3676); assert.ok(cold.edges.some(job => job.support?.length));
  assert.equal(coldCalls, 3676 * 10); assert.equal(route.mock.callCount(), coldCalls);
  for (const p of f.snapshot.owned) { p.probeCount++; f.snapshot.budgets.set(p.planetId, 101); }
  plan(); assert.equal(quote.mock.callCount(), coldCalls); assert.equal(route.mock.callCount(), coldCalls);
  f.snapshot.budgets.set(10000n, 1000);
  assert.ok(plan().edges.some(job => job.sourceId === 10000n && !job.support?.length));
  assert.equal(quote.mock.callCount() - coldCalls, 10, 'a reinforced solo source still gets fresh capture prices');
  t.diagnostic(`3676 sources: cold ${coldCalls} native quote pairs versus prior >=${3676 * 80}; production-only update 0; ${Number(process.hrtime.bigint() - started) / 1e6} ms synthetic total`);
});

test('filling the nearby coalition quota does not hide a farther affordable solo target', () => {
  const f = setup(); f.snapshot.attackMultiplierUpperBound = 1;
  f.world.launchGroup = async () => {};
  const peers = [planet(5n, 0, 1, true), planet(6n, 1, 0, true)];
  f.snapshot.owned.push(...peers);
  for (const p of peers) f.snapshot.budgets.set(p.planetId, 100);
  f.target.probeCount = 200; f.snapshot.planets.find(p => p.planetId === 3n)!.probeCount = 200;
  f.snapshot.planets.push(...peers, { ...planet(9n, 4, 0), probeCount: 10 });
  f.world.quote = (_source, target) => target === 9n ? { count: 12, travelMs: 1000 } : null;
  const result = expansionProposals(f.world, f.snapshot, { ...config, settings: { ...config.settings, candidates: 1, maxSources: 3 } }, f.snapshot.budgets, new Set());
  assert.ok(result.edges.some(job => job.sourceId === 1n && job.targetId === 9n && !job.support?.length));
});

test('a changed technology version cannot relabel or dispatch retained jobs with old prices', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fakeWorld(); f.snapshot.budgets.set(1n, 1000);
  f.snapshot.planets.push(...Array.from({ length: 4 }, (_, i) => planet(BigInt(i + 3), i + 2, 0)));
  let version = 'before', price = 12;
  f.world.read = () => ({ ...f.snapshot, quoteVersion: version });
  f.world.route = () => ({ travelMs: 1000, lossPct: 0 });
  f.world.quote = () => ({ count: price, travelMs: 1000 });
  f.world.syncInventory = async () => {};
  const sends: number[] = [];
  f.world.launch = async (source, _target, count) => {
    sends.push(count); f.snapshot.budgets.set(source, f.snapshot.budgets.get(source)! - count);
  };
  const engine = new Commander(() => {}, () => f.world);
  const run = engine.start('expansion', config); await settle();
  assert.deepEqual(sends, [12]);
  version = 'after'; price = 50;
  for (let i = 0; i < 12; i++) { t.mock.timers.tick(250); await settle(); }
  assert.ok(sends.length > 1); assert.ok(sends.slice(1).every(count => count === 50));
  engine.stop(); t.mock.timers.tick(500); await run;
});
