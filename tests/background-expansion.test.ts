import './helpers/browser';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Commander } from '../src/features/commander/engine';
import type { ExpansionState } from '../src/features/expansion/engine';
import { defaults, members } from '../src/features/expansion/types';
import { defaultPolicy } from '../src/features/commander/types';
import { fakeWorld, planet, settle } from './helpers/fixtures';

const config = { settings: { ...defaults, scanMs: 10000, intervalMs: 1200, candidates: 50, radius: 64, maxSources: 1 }, policy: { ...defaultPolicy, frontlinePercent: 0 } };
function scenario() {
  const f = fakeWorld();
  f.snapshot.planets = [f.source, ...Array.from({ length: 50 }, (_, i) => planet(BigInt(i + 2), i + 1, 0))];
  f.snapshot.budgets.set(1n, 1000);
  const sent: { target: bigint; at: number }[] = [];
  f.world.launch = async (source, target, count) => {
    assert.ok(count <= f.snapshot.budgets.get(source)!);
    f.snapshot.budgets.set(source, f.snapshot.budgets.get(source)! - count);
    sent.push({ target, at: Date.now() });
  };
  f.world.syncInventory = async () => {};
  return { ...f, sent };
}

test('a slow coverage scan preserves the queue and continues the 1.2-second dispatch cadence', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = scenario(); let finish!: () => void, scans = 0;
  f.world.scan = async () => { if (++scans === 2) await new Promise<void>(resolve => { finish = resolve; }); };
  const commander = new Commander(() => {}, () => f.world);
  const run = commander.start('expansion', config); await settle();
  for (let i = 0; i < 10; i++) { t.mock.timers.tick(1200); await settle(); }
  assert.equal(scans, 2); assert.ok(finish); assert.equal(commander.states.expansion.nextScanAt, null);
  assert.equal(f.sent.length, 11); assert.equal(commander.states.expansion.queue.length, 39);
  for (let i = 0; i < 10; i++) { t.mock.timers.tick(1200); await settle(); }
  assert.equal(f.sent.length, 21); assert.equal(scans, 2);
  assert.deepEqual(f.sent.map(s => s.at), Array.from({ length: 21 }, (_, i) => 100000 + i * 1200));
  finish(); await settle();
  assert.equal(commander.states.expansion.nextScanAt, 134000, 'countdown starts after the background plan completes');
  commander.stop(); await run;
});

test('a slow worker does not stop dispatch; its late result merges with remaining jobs and live inventory', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const Original = globalThis.Worker;
  let release!: () => void, rounds = 0;
  t.after(() => { globalThis.Worker = Original; });
  globalThis.Worker = class extends Original {
    postMessage(message: any) {
      if (message.type === 'proposals' && ++rounds === 2) release = () => super.postMessage(message);
      else super.postMessage(message);
    }
  };
  const f = scenario();
  const commander = new Commander(() => {}, () => f.world);
  const run = commander.start('expansion', config); await settle();
  for (let i = 0; i < 10; i++) { t.mock.timers.tick(1200); await settle(); }
  assert.ok(release); const before = f.sent.length;
  for (let i = 0; i < 10; i++) { t.mock.timers.tick(1200); await settle(); }
  assert.equal(f.sent.length, before + 10);
  // A concurrent manual spend is visible only in the live cache. The old draft
  // must not restore already dispatched targets or spend its obsolete budget.
  f.snapshot.budgets.set(1n, 36);
  release(); await settle();
  const queue = commander.states.expansion.queue;
  assert.ok(queue.reduce((n, job) => n + members(job).reduce((sum, m) => sum + m.count, 0), 0) <= 36);
  assert.ok(queue.every(job => !f.sent.some(sent => sent.target === job.targetId)));
  for (let i = 0; i < 5; i++) { t.mock.timers.tick(1200); await settle(); }
  assert.equal(new Set(f.sent.map(s => s.target)).size, f.sent.length);
  commander.stop(); await run;
});

test('stop terminates a waiting worker and discards its queued result without dispatch or leaking the lock', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const Original = globalThis.Worker;
  let release!: () => void; const terminate = mock.fn();
  t.after(() => { globalThis.Worker = Original; });
  globalThis.Worker = class extends Original {
    postMessage(message: any) { release = () => super.postMessage(message); }
    terminate() { terminate(); super.terminate(); }
  };
  const f = scenario(), commander = new Commander(() => {}, () => f.world);
  const run = commander.start('expansion', config); await settle();
  assert.ok(release); commander.stop(); await run;
  release(); await settle(); assert.equal(f.sent.length, 0); assert.equal(terminate.mock.callCount(), 1);
  assert.equal((f.world.dispose as any).mock.callCount(), 1);
});

function sunScenario() {
  const f = scenario();
  Object.assign(f.snapshot, { identity: 'me', allies: new Set(['me']), intelligence: true, fleets: [], automated: new Set(),
    suns: [], meteorites: [], bodyFleets: new Map() });
  f.snapshot.budgets.set(1n, 2000);
  f.world.routeBody = () => ({ travelMs: 1000, lossPct: 0 });
  f.world.quoteBody = () => ({ count: 700, travelMs: 1000 });
  const sunSends: number[] = [];
  f.world.launchBody = async job => {
    assert.ok(job.count <= f.snapshot.budgets.get(job.sourceId)!);
    f.snapshot.budgets.set(job.sourceId, f.snapshot.budgets.get(job.sourceId)! - job.count);
    sunSends.push(Date.now());
    f.snapshot.suns![0].ownerId = { toHexString: () => 'me' };
  };
  const addSun = () => { f.snapshot.suns = [{ sunId: 999n, positionX: 2, positionY: 0, galaxyId: 1n, probeCount: 0 }]; };
  return { ...f, sunSends, addSun };
}

test('slow background rounds publish and eventually dispatch an affordable sun while ordinary sends keep advancing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const Original = globalThis.Worker; let rounds = 0;
  t.after(() => { globalThis.Worker = Original; });
  globalThis.Worker = class extends Original {
    postMessage(message: any) {
      if (message.type === 'proposals' && ++rounds > 1) setTimeout(() => super.postMessage(message), 2500);
      else super.postMessage(message);
    }
  };
  const f = sunScenario(), commander = new Commander(() => {}, () => f.world);
  const run = commander.start('expansion', config); await settle(); f.addSun();
  for (let i = 0; i < 160; i++) { t.mock.timers.tick(250); await settle(); }
  assert.ok(rounds >= 3); assert.ok(f.sent.length > 20);
  assert.equal(commander.states.expansion.queue.filter(job => job.targetKind === 'sun').length + f.sunSends.length, 1);
  for (let i = 0; i < 160; i++) { t.mock.timers.tick(250); await settle(); }
  assert.equal(f.sunSends.length, 1, 'new refills cannot push the retained sun indefinitely behind ordinary jobs');
  commander.stop(); t.mock.timers.tick(3000); await run;
});

for (const change of ['inventory', 'ownership', 'garrison'] as const) {
  test(`a sun invalidated by ${change} releases its draft reservation without clearing valid retained jobs`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
    const Original = globalThis.Worker; let release!: () => void, rounds = 0;
    t.after(() => { globalThis.Worker = Original; });
    globalThis.Worker = class extends Original {
      postMessage(message: any) {
        if (message.type === 'proposals' && ++rounds === 2) release = () => super.postMessage(message);
        else super.postMessage(message);
      }
    };
    const f = sunScenario();
    let published: ExpansionState | undefined;
    const commander = new Commander((_mode, state) => {
      if (!published && release && state.phase.startsWith('后台评估完成')) published = state;
    }, () => f.world);
    const run = commander.start('expansion', { ...config, settings: { ...config.settings, intervalMs: 1500 } });
    await settle(); f.addSun();
    for (let i = 0; i < 40; i++) { t.mock.timers.tick(250); await settle(); }
    assert.ok(release);
    const retained = [...commander.states.expansion.queue];
    assert.equal(retained.length, 43);
    if (change === 'inventory') f.snapshot.budgets.set(1n, 600);
    if (change === 'ownership') f.snapshot.suns![0].ownerId = { toHexString: () => 'other' };
    if (change === 'garrison') f.snapshot.suns![0].probeCount++;
    release(); await settle();
    assert.ok(published);
    assert.ok(retained.every(job => published!.queue.includes(job)), 'all funded retained jobs survive the merge');
    assert.ok(!published.queue.some(job => job.targetKind === 'sun'));
    assert.ok(published.queue.reduce((n, job) => n + job.count, 0) <= f.snapshot.budgets.get(1n)!);
    const sent = f.sent.length;
    for (let i = 0; i < 12; i++) { t.mock.timers.tick(250); await settle(); }
    assert.equal(f.sent.length, sent + 2, 'no orphaned reservation blocks the next dispatch slots');
    commander.stop(); await run;
  });
}

test('cancelling a superseded sun wait cannot clear the replacement sun reservation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  localStorage.setItem('swarm-helper-last-operation-v1', '100000');
  const f = sunScenario(); f.addSun();
  let needsScan = false, heldAtSend: number | undefined;
  f.world.needsScan = () => needsScan;
  f.world.scan = async () => { needsScan = false; };
  const launch = f.world.launch;
  f.world.launch = async (...args) => { heldAtSend = (commander as any).sunReservations.get(1n); await launch(...args); };
  const commander = new Commander(() => {}, () => f.world);
  const run = commander.start('expansion', { ...config, settings: { ...config.settings, candidates: 1 } }); await settle();
  assert.equal(commander.states.expansion.queue[0].targetKind, 'sun');
  f.snapshot.suns![0].ownerId = { toHexString: () => 'other' };
  f.snapshot.suns!.push({ sunId: 1000n, positionX: 3, positionY: 0, galaxyId: 1n, probeCount: 0 });
  needsScan = true; t.mock.timers.tick(250); await settle();
  assert.ok(commander.states.expansion.queue.some(job => job.targetKind === 'sun' && job.targetId === 1000n));
  t.mock.timers.tick(950); await settle();
  assert.equal(heldAtSend, 700, 'the old waiting task must not release the replacement plan\'s budget');
  commander.stop(); await run;
});
