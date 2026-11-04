import './helpers/browser';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { MeteoriteFrontier } from '../src/features/expansion/meteorite-frontier';
import { finishPlanning } from '../src/runtime/planning';
import { defaults } from '../src/features/expansion/types';
import { defaultPolicy } from '../src/features/commander/types';
import { fakeWorld, planet } from './helpers/fixtures';

const config = { settings: { ...defaults, radius: 128 }, policy: defaultPolicy };
function setup(size = 1) {
  const f = fakeWorld();
  f.snapshot.owned = Array.from({ length: size }, (_, i) => planet(BigInt(i + 1), i % 64, Math.floor(i / 64), true));
  f.snapshot.budgets = new Map(f.snapshot.owned.map(p => [p.planetId, 20]));
  f.snapshot.meteorites = [{ meteoriteId: 2n, positionX: 0, positionY: 0, galaxyId: 1n, probeCount: 1, expiresAt: { toMillis: () => Date.now() + 60000 } }];
  f.world.quoteBody = mock.fn(() => ({ count: 3, travelMs: 1000 }));
  f.world.launchBody = mock.fn(async () => {});
  const planner = new MeteoriteFrontier();
  const plan = (locked = new Set<string>(), queueMs = 0, budgets = f.snapshot.budgets) => finishPlanning(planner.steps(f.world, f.snapshot, config, budgets, locked, queueMs));
  return { ...f, planner, plan };
}

test('4,000 sources have a bounded meteorite pass and rotate past unreachable nearest sources', () => {
  const f = setup(4000), checked: bigint[] = [];
  f.world.quoteBody = (source) => { checked.push(source); return source === 129n ? { count: 3, travelMs: 1000 } : null; };
  let found = false;
  for (let i = 0; i < 10 && !found; i++) {
    const before = checked.length, result = f.plan();
    assert.ok(checked.length - before <= 4);
    found = result.jobs.some(j => j.sourceId === 129n);
  }
  assert.ok(found, 'the search must advance beyond the first four sources');
  assert.equal((f.world.launchBody as any).mock.callCount(), 0, 'planning never dispatches');
});

test('meteorite diagnostics explain reserved stock, queue expiry, flight locks and range', () => {
  const f = setup();
  assert.equal(f.plan(new Set(['planet:2'])).jobs.length, 1, 'same numeric planet id does not lock a comet');
  assert.match(f.plan(new Set(['comet:2'])).reports[0].reason, /已有舰队/);
  assert.match(f.plan(new Set(), 55000).reports[0].reason, /排队.*消失前/);
  assert.match(f.plan(new Set(), 0, new Map([[1n, 2]])).reports[0].reason, /需 3，可用 2/);
  assert.match(f.plan(new Set(), 0, new Map([[1n, 0]])).reports[0].reason, /留守、进攻、补给或排队/);
  f.world.quoteBody = () => ({ count: 3, travelMs: defaults.maxTravelMs + 1 });
  assert.match(f.plan().reports[0].reason, /超过最长航行/);
  f.snapshot.owned[0].positionX = 1000;
  assert.match(f.plan().reports[0].reason, /没有己方来源/);
});

test('fast meteorite jobs share their local budget and target rotation covers more than eight bodies', () => {
  const f = setup();
  const base = f.snapshot.meteorites![0];
  f.snapshot.meteorites = Array.from({ length: 12 }, (_, i) => ({ ...base, meteoriteId: BigInt(i + 100) }));
  const locked = new Set(Array.from({ length: 10 }, (_, i) => `comet:${i + 100}`));
  assert.equal(f.plan(locked).jobs.length, 0);
  const next = f.plan(locked, 0, new Map([[1n, 5]]));
  assert.equal(next.jobs.length, 1); assert.equal(next.jobs[0].targetId, 110n);
  assert.ok(next.reports.some(r => /需 3，可用 2/.test(r.reason)));
});
