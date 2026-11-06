import './helpers/browser';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Commander } from '../src/features/commander/engine';
import { defaultPolicy } from '../src/features/commander/types';
import { defaults, members, type Assignment } from '../src/features/expansion/types';
import { fakeWorld, planet, settle } from './helpers/fixtures';

function starfield(shared: number) {
  const f = fakeWorld();
  const hubs = [1n, 2n, 3n, 4n].map((id, i) => planet(id, i * 3, 0, true));
  const donor = planet(8n, 4, 1, true);
  f.snapshot.planets = f.snapshot.owned = [...hubs, donor];
  f.snapshot.suns = hubs.map(p => ({ sunId: p.planetId + 10n, positionX: p.positionX, positionY: 1, galaxyId: 1n, probeCount: 0 }));
  f.snapshot.budgets = new Map([...hubs.map(p => [p.planetId, 60] as const), [donor.planetId, shared]]);
  f.snapshot.intelligence = true; f.snapshot.identity = 'me'; f.snapshot.quoteVersion = 'rules';
  f.world.route = source => source === donor.planetId ? { travelMs: 60000, lossPct: 0 } : null;
  f.world.routeBody = (hub, sun) => hub + 10n === sun ? { travelMs: 20000, lossPct: 0 } : null;
  f.world.quoteBody = (hub, sun) => hub + 10n === sun && f.snapshot.budgets.get(hub)! >= 100 ? { count: 100, travelMs: 20000 } : null;
  f.world.syncInventory = async () => {};
  const supplies: Assignment[] = [], captures: Assignment[] = [], sentAt: number[] = [];
  f.world.launchGroup = async job => {
    supplies.push(job); sentAt.push(Date.now());
    for (const m of members(job)) f.snapshot.budgets.set(m.sourceId, f.snapshot.budgets.get(m.sourceId)! - m.count);
  };
  f.world.launchBody = async job => { captures.push(job); f.snapshot.budgets.set(job.sourceId, f.snapshot.budgets.get(job.sourceId)! - job.count); };
  const commander = new Commander(() => {}, () => f.world);
  const run = commander.start('expansion', { settings: { ...defaults }, policy: defaultPolicy });
  return { ...f, commander, run, supplies, captures, sentAt };
}

test('three sun campaigns send supplies before any delivery arrives, then launch independently', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  t.mock.method(Math, 'random', () => 0.5);
  const f = starfield(160);
  const advance = async (n: number) => { for (let i = 0; i < n; i++) { t.mock.timers.tick(1500); await settle(); } };
  try {
    await settle(); await advance(12);
    assert.equal(f.supplies.length, 3);
    assert.equal(new Set(f.supplies.map(j => j.sunId)).size, 3);
    assert.equal(new Set(f.supplies.map(j => j.targetId)).size, 3);
    assert.deepEqual(f.supplies.map(j => [j.sourceId, j.count]), [[8n, 40], [8n, 40], [8n, 40]]);
    assert.ok(f.sentAt.every((at, i) => !i || at - f.sentAt[i - 1] >= 1000));
    assert.equal(f.snapshot.budgets.get(8n), 40);
    assert.equal(f.captures.length, 0);
    assert.equal(f.commander.states.expansion.logistics?.filter(p => p.kind === 'sun' && p.incoming === 40).length, 3);
    const second = f.supplies[1];
    f.snapshot.budgets.set(second.targetId, 100);
    await advance(5);
    assert.deepEqual(f.captures.map(j => [j.sourceId, j.targetId]), [[second.targetId, second.sunId]]);
    assert.equal(f.supplies.length, 4, 'the freed slot can begin funding the fourth sun');
    assert.equal(new Set(f.supplies.map(j => j.sunId)).size, 4);
  } finally { f.commander.stop(); await f.run; }
});

test('losing one funded target does not duplicate or cancel supply for the other hub', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = starfield(80);
  const advance = async (n: number) => { for (let i = 0; i < n; i++) { t.mock.timers.tick(2000); await settle(); } };
  try {
    await settle(); await advance(6);
    assert.equal(f.supplies.length, 2);
    const [lost, surviving] = f.supplies;
    f.snapshot.suns!.find(sun => sun.sunId === lost.sunId)!.ownerId = { toHexString: () => 'other' };
    f.snapshot.budgets.set(surviving.targetId, 100);
    await advance(6);
    assert.deepEqual(f.captures.map(j => j.targetId), [surviving.sunId]);
    assert.equal(f.supplies.length, 2);
  } finally { f.commander.stop(); await f.run; }
});

test('insufficient shared probes cannot fund a second sun with the first campaign allocation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = starfield(75);
  try {
    await settle();
    for (let i = 0; i < 8; i++) { t.mock.timers.tick(1500); await settle(); }
    assert.equal(f.supplies.length, 1);
    assert.equal(f.snapshot.budgets.get(8n), 35);
    assert.deepEqual(f.captures, []);
  } finally { f.commander.stop(); await f.run; }
  assert.deepEqual(f.commander.states.expansion.suns, []);
});
