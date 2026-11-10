import './helpers/browser';
import { test, mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Commander } from '../src/features/commander/engine';
import { defaults, type Assignment } from '../src/features/expansion/types';
import { defaultPolicy } from '../src/features/commander/types';
import { fakeWorld, planet, settle } from './helpers/fixtures';
import { unresolved, withControl } from '../src/runtime/operations';

function gathering(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fakeWorld(), donor = planet(3n, 0, 1, true);
  f.source.level = donor.level = 1;
  f.snapshot.owned.push(donor); f.snapshot.planets = [...f.snapshot.owned];
  f.snapshot.budgets = new Map([[1n, 60], [3n, 60]]);
  const upgrading = new Set([1n, 3n]);
  Object.assign(f.snapshot, { identity: 'me', allies: new Set(['me']), intelligence: true, automated: new Set(),
    autoUpgrading: upgrading, fleets: [], bodyFleets: new Map(), meteorites: [],
    suns: [{ sunId: 2n, positionX: 2, positionY: 0, galaxyId: 1n, probeCount: 0 }] });
  f.world.quote = () => null;
  f.world.route = () => ({ travelMs: 1000, lossPct: 0 });
  f.world.routeBody = () => ({ travelMs: 2000, lossPct: 0 });
  f.world.quoteBody = () => null;
  f.world.launchBody = mock.fn(async () => {});
  const supplies: { job: Assignment; at: number }[] = [];
  f.world.launchGroup = async job => { supplies.push({ job, at: Date.now() }); };
  f.world.syncInventory = async () => {};
  const commander = new Commander(() => {}, () => f.world);
  const advance = async (ms = 2000) => { for (let i = 0; i < ms; i += 250) { t.mock.timers.tick(250); await settle(); } };
  const start = async () => {
    const run = commander.start('expansion', { settings: { ...defaults, intervalMs: 1000 }, policy: { ...defaultPolicy, frontlinePercent: 0 } });
    t.after(async () => { commander.stop(); await advance(16000); await run; });
    await settle(); await advance(250);
  };
  return { ...f, commander, upgrading, supplies, advance, start };
}

test('sun supply waits for auto-upgrade shutdown and the next operation interval, leaving donors unchanged', async t => {
  const f = gathering(t);
  let confirm!: () => void;
  const shutdowns: { id: bigint; at: number }[] = [];
  f.world.disableAutoUpgrade = id => {
    shutdowns.push({ id, at: Date.now() });
    return new Promise<void>(resolve => { confirm = () => { f.upgrading.delete(id); resolve(); }; });
  };
  await f.start();
  assert.deepEqual(shutdowns.map(s => s.id), [1n]);
  assert.equal(f.supplies.length, 0);
  confirm(); await settle(); await f.advance();
  assert.equal(f.supplies.length, 1);
  assert.equal(f.supplies[0].job.kind, 'sun-supply');
  assert.equal(f.supplies[0].job.targetId, 1n);
  assert.ok(f.supplies[0].at - shutdowns[0].at >= 1000);
  assert.equal(f.upgrading.has(3n), true);
  assert.equal(shutdowns.length, 1);
});

test('sun supply does not change native settings when its hub already has auto-upgrade disabled', async t => {
  const f = gathering(t); f.upgrading.delete(1n);
  const disable = f.world.disableAutoUpgrade = mock.fn(async () => {});
  await f.start(); await f.advance();
  assert.equal(disable.mock.callCount(), 0);
  assert.equal(f.supplies.length, 1);
});

for (const failure of ['missing', 'rejected', 'unchanged', 'timeout'] as const) {
  test(`sun supply does not launch or debit stock when auto-upgrade shutdown is ${failure}`, async t => {
    const f = gathering(t);
    if (failure === 'rejected') f.world.disableAutoUpgrade = async () => { throw new Error('服务器拒绝'); };
    if (failure === 'unchanged') f.world.disableAutoUpgrade = async () => {};
    if (failure === 'timeout') f.world.disableAutoUpgrade = () => new Promise(() => {});
    await f.start(); await f.advance(failure === 'timeout' ? 16000 : 2000);
    assert.equal(f.supplies.length, 0);
    assert.equal(f.commander.states.expansion.sent, 0);
    assert.equal(f.commander.states.expansion.running, true);
    assert.deepEqual([...f.snapshot.budgets], [[1n, 60], [3n, 60]]);
    assert.equal(unresolved(), false);
  });
}

for (const change of ['stop', 'ownership', 'inventory', 'reenabled'] as const) {
  test(`sun supply revalidates after shutdown when ${change} changes`, async t => {
    const f = gathering(t);
    let confirm!: () => void;
    f.world.disableAutoUpgrade = id => new Promise<void>(resolve => {
      confirm = () => { f.upgrading.delete(id); resolve(); };
    });
    await f.start();
    if (change === 'stop') f.commander.stop();
    if (change === 'ownership') { f.source.ownerId = undefined; f.snapshot.owned = f.snapshot.owned.filter(p => p.planetId !== 1n); }
    if (change === 'inventory') f.snapshot.budgets.set(3n, 0);
    confirm(); await settle();
    if (change === 'reenabled') f.upgrading.add(1n);
    await f.advance();
    assert.equal(f.supplies.length, 0);
    if (change === 'stop') { assert.equal(f.commander.states.expansion.running, false); await withControl(async () => {}); }
  });
}
