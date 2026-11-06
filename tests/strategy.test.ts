import './helpers/browser';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planet, fakeWorld, identity } from './helpers/fixtures';
import { defaults } from '../src/features/expansion/types';
import { defaultPolicy, inZone, type ModeConfig } from '../src/features/commander/types';
import { availableBudgets, reserveFor } from '../src/features/commander/safety';
import { attackQuote, planAttack } from '../src/features/attack/planner';
import { expansionProposals, expansionQuote } from '../src/features/expansion/proposals';
import { safeQuote } from '../src/game/expansion-world';
import { planExpansion } from '../src/features/expansion/planner';
import { loadPolicies, parsePolicy, policyForm, savePolicies } from '../src/app/regions';

const enemy = 'a'.repeat(64);
const config = (): ModeConfig => ({ settings: { ...defaults }, policy: { ...defaultPolicy, zone: { x: 0, y: 0, radius: 8 }, enemy, frontlinePercent: 0 } });
function intelligence() {
  const f = fakeWorld();
  f.snapshot.identity = 'me'; f.snapshot.allies = new Set(['me']); f.snapshot.intelligence = true;
  f.snapshot.fleets = []; f.snapshot.automated = new Set();
  f.source.level = 5; f.source.probeCount = 100; f.snapshot.budgets.set(1n, 100);
  f.target.level = 3; f.target.ownerId = { toHexString: () => enemy };
  f.world.route = () => ({ travelMs: 1000, lossPct: 0 });
  return f;
}

test('dynamic reserve adds worst-case incoming strength, uses strictest overlapping policy and excludes server automation', () => {
  const f = intelligence(); const c = config(); c.policy.frontlinePercent = 25; c.settings.reserve = 10;
  f.snapshot.fleets = [
    { id: 1n, owner: enemy, target: 1n, count: 10, arrival: 200000, arriving: 10 },
    { id: 2n, owner: 'me', target: 1n, count: 1000, arrival: 200000, arriving: 1000 },
  ];
  assert.equal(reserveFor(f.source, f.snapshot, [c]), 47);
  const stricter = structuredClone(c); stricter.settings.reserve = 60;
  assert.equal(availableBudgets(f.snapshot, [c, stricter], new Map([[1n, 5]])).get(1n), 13);
  f.snapshot.fleets[0].count = null;
  assert.equal(availableBudgets(f.snapshot, [c], new Map()).get(1n), 0);
  f.snapshot.fleets = []; f.snapshot.automated!.add(1n);
  assert.equal(availableBudgets(f.snapshot, [c], new Map()).get(1n), 0);
});

test('single attacks add occupation and production margins, filter the selected enemy and never attack allies', () => {
  const f = intelligence(), c = config();
  assert.equal(attackQuote(f.world, f.snapshot, f.source, f.target, c)?.count, 28);
  const plan = planAttack(f.world, f.snapshot, c, new Map([[1n, 100]]), new Set());
  assert.equal(plan.job?.targetId, 2n); assert.equal(plan.job?.support, undefined);
  c.policy.enemy = 'b'.repeat(64);
  assert.equal(planAttack(f.world, f.snapshot, c, new Map([[1n, 100]]), new Set()).job, undefined);
  c.policy.enemy = null; f.snapshot.allies!.add(enemy);
  assert.equal(attackQuote(f.world, f.snapshot, f.source, f.target, c), null);
});

test('direct attack allocation captures two targets instead of greedily spending the only source that can reach the second', () => {
  const f = intelligence(), c = config(); c.policy.holdProbes = 2;
  f.target.level = 1;
  const other = planet(3n, 2, 0); other.level = 1; other.ownerId = { toHexString: () => enemy };
  const backup = planet(4n, 0, 1, true); backup.level = 1;
  f.snapshot.owned.push(backup); f.snapshot.planets.push(other, backup);
  f.world.quote = (source, target) => source === 4n && target === 3n ? null : { count: 6, travelMs: 1000 };
  const plan = planAttack(f.world, f.snapshot, c, new Map([[1n, 10], [4n, 10]]), new Set());
  assert.equal(plan.exact, true); assert.equal(plan.jobs?.length, 2);
  assert.ok(plan.jobs!.some(j => j.sourceId === 1n && j.targetId === 3n));
  assert.ok(plan.jobs!.some(j => j.sourceId === 4n && j.targetId === 2n));
});

test('fixed zone bounds both source and target; foreign or own fleets block enemy single attacks', () => {
  const f = intelligence(), c = config();
  f.source.positionX = -9;
  assert.equal(attackQuote(f.world, f.snapshot, f.source, f.target, c), null);
  f.source.positionX = 0; f.target.positionX = 9;
  assert.equal(attackQuote(f.world, f.snapshot, f.source, f.target, c), null);
  f.target.positionX = 1;
  for (const owner of [enemy, 'me']) {
    f.snapshot.fleets = [{ id: 1n, owner, target: 2n, count: 1, arrival: 900000, arriving: 1 }];
    assert.equal(attackQuote(f.world, f.snapshot, f.source, f.target, c), null);
  }
  assert.equal(inZone(planet(9n, 8, 0), c.policy.zone), true);
});

test('native capture cost already includes a 90 percent border loss and invalid routes fail closed', () => {
  assert.deepEqual(safeQuote({ travelMs: 1000, lossPct: 90, outOfRange: false, exact: { reason: 'capture', probes: 20 } }), { count: 20, travelMs: 1000 });
  for (const lossPct of [100, NaN, -1]) assert.equal(safeQuote({ travelMs: 1, lossPct, outOfRange: false, exact: { reason: 'capture', probes: 20 } }), null);
});

test('neutral top-ups use a confirmed arrival lower bound and ignore conflicted candidates before applying n', () => {
  const f = intelligence(), c = config(); f.target.ownerId = undefined;
  f.snapshot.incoming.add(2n);
  f.snapshot.fleets = [{ id: 1n, owner: 'me', target: 2n, count: 10, arriving: 10, arrival: Date.now() + 500 }];
  assert.equal(expansionQuote(f.world, f.snapshot, f.source, f.target, c)?.count, 11);
  f.snapshot.fleets[0].arriving = null;
  assert.equal(expansionQuote(f.world, f.snapshot, f.source, f.target, c), null);
  const other = planet(3n, 3, 0); f.snapshot.planets.push(other); c.settings.candidates = 1;
  const proposals = expansionProposals(f.world, f.snapshot, c, new Map([[1n, 100]]), new Set());
  assert.deepEqual(proposals.edges.map(e => e.targetId), [3n]);
  f.snapshot.fleets[0].arriving = 100;
  assert.equal(expansionQuote(f.world, f.snapshot, f.source, f.target, c), null);
  f.snapshot.fleets[0].arriving = 10; f.snapshot.fleets[0].owner = enemy;
  assert.equal(expansionQuote(f.world, f.snapshot, f.source, f.target, c), null);
});

test('regional expansion never borrows outside sources, even when a coalition could succeed', () => {
  const f = intelligence(), c = config(); f.target.ownerId = undefined;
  const outside = planet(4n, 9, 0, true); f.snapshot.owned.push(outside); f.snapshot.planets.push(outside);
  f.snapshot.budgets.set(4n, 100);
  const proposals = expansionProposals(f.world, f.snapshot, c, new Map([[1n, 0], [4n, 100]]), new Set());
  assert.equal(proposals.edges.length, 0);
});

test('large plans are bounded and explicitly approximate; productive footholds win equal-count choices', () => {
  const edges = Array.from({ length: 2000 }, (_, i) => ({ sourceId: 1n, targetId: BigInt(i + 2), count: 1, travelMs: 1000, value: i / 100 }));
  const plan = planExpansion(edges, new Map([[1n, 5000]]), 1000, 600000);
  assert.equal(plan.exact, false); assert.ok(plan.jobs.length <= 128);
  const productive = planExpansion([{ sourceId: 1n, targetId: 2n, count: 10, travelMs: 1000, value: 1 }, { sourceId: 1n, targetId: 3n, count: 10, travelMs: 2000, value: 4 }], new Map([[1n, 10]]), 1000, 120000);
  assert.equal(productive.jobs[0].targetId, 3n);
});

test('region preferences persist independently and invalid/missing attack regions never become an all-world attack', () => {
  const forms = { expansion: policyForm('expansion'), attack: { ...policyForm('attack'), x: '100', y: '-200', enemy } };
  savePolicies(forms);
  assert.deepEqual(loadPolicies(), forms);
  assert.throws(() => parsePolicy(policyForm('attack'), 'attack'), /选取/);
  assert.throws(() => parsePolicy({ ...forms.attack, scope: 'all' }, 'attack'), /战区/);
  assert.throws(() => parsePolicy({ ...forms.attack, enemy: 'bad' }, 'attack'), /敌人/);
});
