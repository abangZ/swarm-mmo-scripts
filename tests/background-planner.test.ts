import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { BackgroundPlanner } from '../src/features/expansion/background-planner';
import { expansionProposals } from '../src/features/expansion/proposals';
import { planExpansion } from '../src/features/expansion/planner';
import { defaults } from '../src/features/expansion/types';
import { defaultPolicy } from '../src/features/commander/types';
import type { ExpansionWorld, WorldSnapshot } from '../src/features/expansion/world';
import { fakeWorld, planet } from './helpers/fixtures';

test('cooperative planning works without Worker and preserves all 1311 sources / 566 targets and quote counts', async t => {
  const owner = { toHexString: () => 'me' };
  const makePlanet = (i: number, owned: boolean) => ({ planetId: BigInt(i) + (owned ? 9007199254740993n : 10000n),
    positionX: i % 40 - 20, positionY: Math.floor(i / 40) - 10, galaxyId: 1n, probeCount: 30 + i % 13,
    level: i % 8 + 1, ownerId: owned ? owner : undefined });
  const owned = Array.from({ length: 1311 }, (_, i) => makePlanet(i, true));
  const snapshot: WorldSnapshot = { owned, planets: [...owned, ...Array.from({ length: 566 }, (_, i) => makePlanet(i, false))],
    budgets: new Map(owned.map(p => [p.planetId, 100])), incoming: new Set(), identity: 'me', intelligence: true, fleets: [] };
  let quoteCalls = 0;
  const world: ExpansionWorld = { read: () => snapshot, scan: async () => {}, dispose() {}, launch: async () => {}, launchGroup: async () => {},
    quote: (source, target) => { quoteCalls++; return { count: 32 + Number(target % 13n), travelMs: 60000 + Number((source + target) % 100n) * 1000 }; },
    route: (source, target) => ({ travelMs: 60000 + Number((source + target) % 100n) * 1000, lossPct: 0 }) };
  const config = { settings: { ...defaults, radius: 64, intervalMs: 1200 }, policy: defaultPolicy };
  const expected = expansionProposals(world, snapshot, config, snapshot.budgets, new Set());
  const originalQuoteCalls = quoteCalls; quoteCalls = 0;
  const worker = t.mock.fn(() => { throw new Error('Blocked by CSP'); });
  Object.assign(globalThis, { Worker: worker, scheduler: { postTask: async (task: () => void, options: { priority: string }) => {
    assert.equal(options.priority, 'background'); await setImmediate(); task();
  } } });
  t.after(() => { delete (globalThis as any).Worker; delete (globalThis as any).scheduler; });
  const planner = new BackgroundPlanner(), controller = new AbortController();
  t.after(() => planner.dispose());
  let heartbeats = 0;
  const timer = setInterval(() => heartbeats++, 10); t.after(() => clearInterval(timer));
  const started = performance.now();
  const proposals = await planner.proposals(world, snapshot, config, snapshot.budgets, new Set(), controller.signal, () => true);
  assert.ok(proposals);
  const planned = await planner.plan(world, proposals.edges, snapshot.budgets, 1200, 120000, 1800000, 0, controller.signal, () => true);
  assert.ok(planned);
  const elapsed = performance.now() - started;
  assert.deepEqual(proposals, expected);
  assert.equal(quoteCalls, originalQuoteCalls, 'slicing must not add native quote calls');
  assert.deepEqual(planned, planExpansion(expected.edges, snapshot.budgets, 1200, 120000, 1800000));
  assert.ok(heartbeats > 0, 'main thread timers keep running between planning slices');
  assert.equal(proposals.sources.length, 1311);
  assert.equal(worker.mock.callCount(), 0);
  t.diagnostic(`1311 sources / 566 targets: cooperative round ${elapsed.toFixed(0)} ms, ${planned.jobs.length} jobs, ${heartbeats} main-thread heartbeats; synthetic in-memory quotes`);
});

for (const cancel of ['abort', 'dispose', 'config'] as const) {
  test(`a slow native quote yields before the next quote, and ${cancel} discards the draft`, async t => {
    const f = fakeWorld();
    f.snapshot.planets.push(planet(3n, 2, 0));
    const planner = new BackgroundPlanner(), controller = new AbortController();
    let time = 0, active = true, calls = 0, release!: () => void, refreshes = 0;
    t.mock.method(performance, 'now', () => time);
    f.world.quote = () => { calls++; time += 9; return { count: 12, travelMs: 1000 }; };
    f.world.refreshQuotes = () => { refreshes++; };
    Object.assign(globalThis, { scheduler: { postTask: () => new Promise<void>(resolve => { release = resolve; }) } });
    t.after(() => { delete (globalThis as any).scheduler; planner.dispose(); });
    const result = planner.proposals(f.world, f.snapshot, { settings: defaults, policy: defaultPolicy },
      f.snapshot.budgets, new Set(), controller.signal, () => active);
    assert.ok(release); assert.equal(calls, 1); assert.equal(refreshes, 1);
    if (cancel === 'abort') controller.abort();
    else if (cancel === 'dispose') planner.dispose();
    else active = false;
    release();
    assert.equal(await result, undefined);
    assert.equal(calls, 1, 'cancelled work must not read more native quotes');
    assert.equal(refreshes, 1, 'cancelled work must not refresh subscriptions');
  });
}
