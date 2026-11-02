import './helpers/browser';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Commander } from '../src/features/commander/engine';
import { ExpansionEngine } from '../src/features/expansion/engine';
import { defaults } from '../src/features/expansion/types';
import { defaultPolicy } from '../src/features/commander/types';
import { AppController } from '../src/app/controller';
import { expansionInterval, unresolved, withControl } from '../src/runtime/operations';
import { fakeWorld, planet, settle } from './helpers/fixtures';

const settings = { ...defaults, intervalMs: 1200, scanMs: 30000, maxSources: 1 };
function queueWorld(stock = 48, targets = 4) {
  const f = fakeWorld();
  f.snapshot.budgets.set(1n, stock);
  f.snapshot.planets = [f.source, ...Array.from({ length: targets }, (_, i) => planet(BigInt(i + 2), i + 1, 0))];
  f.world.quote = () => ({ count: 12, travelMs: 60000 });
  return f;
}

test('expansion transmits from one source without receipts at 1.0, 1.4 and 1.2 seconds, using a stale or already-updated cache safely', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  for (const applied of [false, true]) {
    const f = queueWorld();
    const times: number[] = [], amounts: number[] = [];
    const random = [0.5, 0, 1, 0.5];
    t.mock.method(Math, 'random', () => random.shift() ?? 0.5);
    f.world.launch = (_source, _target, count) => {
      times.push(Date.now()); amounts.push(count);
      if (applied) f.snapshot.budgets.set(1n, f.snapshot.budgets.get(1n)! - count);
      return new Promise<void>(() => {});
    };
    f.world.syncInventory = async () => { f.snapshot.budgets.set(1n, 0); };
    const engine = new ExpansionEngine(() => {}, () => f.world);
    const started = Date.now(), run = engine.start(settings); await settle();
    for (const interval of [1000, 1400, 1200]) { t.mock.timers.tick(interval); await settle(); }
    assert.deepEqual(times, [started, started + 1000, started + 2400, started + 3600]);
    assert.equal(amounts.reduce((a, b) => a + b, 0), 48);
    assert.equal(engine.running, true); assert.equal(unresolved(), false);
    assert.equal(localStorage.getItem('swarm-helper-uncertain-v1'), null);
    engine.stop(); t.mock.timers.tick(15000); await run;
    await withControl(async () => {});
  }
  t.mock.method(Math, 'random', () => 0);
  assert.equal(expansionInterval(1000), 1000, 'jitter retains a one-second minimum');
});

test('an earlier receipt and sync cannot free stock still spent by later unconfirmed expansion requests', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = queueWorld(36, 5), receipts: (() => void)[] = [], sent: bigint[] = [];
  f.world.launch = (_source, target) => { sent.push(target); return new Promise<void>(resolve => receipts.push(resolve)); };
  f.world.syncInventory = async () => {};
  const engine = new ExpansionEngine(() => {}, () => f.world);
  const run = engine.start(settings); await settle();
  t.mock.timers.tick(1200); await settle();
  receipts[0](); await settle();
  t.mock.timers.tick(1200); await settle();
  t.mock.timers.tick(1200); await settle();
  assert.equal(sent.length, 3, 'the stale 36-probe cache cannot fund a fourth 12-probe send');
  engine.stop(); receipts.slice(1).forEach(resolve => resolve()); await run;
});

test('rejection and inventory sync failures skip targets and automatically retry only inventory, without blocking the next launch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = queueWorld(), sent: bigint[] = [];
  f.world.launch = async (_source, target) => { sent.push(target); if (target === 2n) throw new Error('rejected'); };
  let syncs = 0;
  f.world.syncInventory = async () => { if (++syncs <= 5) throw new Error('temporary sync failure'); };
  const engine = new ExpansionEngine(() => {}, () => f.world);
  const run = engine.start(settings); await settle();
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(1200); await settle(); }
  assert.deepEqual(sent, [2n, 3n, 4n, 5n]);
  assert.equal(engine.running, true); assert.equal(unresolved(), false);
  t.mock.timers.tick(5000); await settle();
  assert.ok(syncs >= 6, 'dirty sources are automatically synchronized again');
  assert.equal(sent.filter(id => id === 2n).length, 1, 'a failed request is not immediately retried');
  engine.stop(); await run;
});

test('late receipt rejection after timeout is consumed without restarting or locking expansion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = queueWorld(24, 2); let reject!: (error: Error) => void;
  f.world.launch = mock.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  f.world.syncInventory = async () => {};
  const engine = new ExpansionEngine(() => {}, () => f.world);
  const run = engine.start(settings); await settle();
  const firstReject = reject;
  t.mock.timers.tick(1200); await settle();
  t.mock.timers.tick(15000); await settle();
  assert.equal(engine.running, true); assert.equal(unresolved(), false);
  engine.stop(); await run;
  firstReject(new Error('late error')); reject(new Error('another late error')); await settle();
  assert.equal(engine.running, false); assert.equal(unresolved(), false);
  assert.equal((f.world.launch as any).mock.callCount(), 2);
});

test('background expansion reconnects automatically, but stops on identity change or explicit stop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  t.mock.getter(document, 'visibilityState', () => 'hidden');
  const broken = fakeWorld(), healthy = queueWorld(24, 2);
  broken.world.scan = async () => { throw new Error('connection lost'); };
  healthy.snapshot.identity = 'me';
  let worlds = 0;
  const factory = mock.fn(() => ++worlds === 1 ? broken.world : healthy.world);
  const commander = new Commander(() => {}, factory);
  const run = commander.start('expansion', { settings, policy: defaultPolicy }); await settle();
  assert.match(commander.states.expansion.phase, /自动尝试恢复/);
  t.mock.timers.tick(5000); await settle();
  assert.equal(factory.mock.callCount(), 2);
  assert.equal((healthy.world.launch as any).mock.callCount(), 1, 'hidden tabs continue expansion');
  t.mock.timers.tick(1200); await settle();
  assert.equal((healthy.world.launch as any).mock.callCount(), 2);
  healthy.snapshot.identity = 'another-account';
  healthy.world.needsScan = () => true;
  t.mock.timers.tick(250); await run;
  assert.equal(commander.states.expansion.running, false);
  assert.match(commander.states.expansion.phase, /身份已变化/);
  assert.equal((broken.world.dispose as any).mock.callCount(), 1);
  assert.equal((healthy.world.dispose as any).mock.callCount(), 1);

  const retry = new Commander(() => {}, () => broken.world);
  const pending = retry.start('expansion', { settings, policy: defaultPolicy }); await settle();
  retry.stop(); await pending;
  t.mock.timers.tick(10000); await settle();
  assert.equal(retry.states.expansion.running, false);
});

test('24 simulated hours with recurring lost receipts and sync failures keeps expansion running and logs bounded', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fakeWorld(); let target = 2n, launches = 0, syncs = 0;
  f.world.scan = async () => {
    f.snapshot.planets = [f.source, planet(target++, 1, 0)];
    f.snapshot.budgets.set(1n, 100);
  };
  f.world.launch = () => ++launches % 3 ? Promise.resolve() : new Promise<void>(() => {});
  f.world.syncInventory = async () => { if (++syncs % 5 === 0) throw new Error('temporary sync error'); };
  localStorage.setItem('swarm-helper-uncertain-v1', JSON.stringify({ expansion: 'old-timeout' }));
  const controller = new AppController(() => f.world);
  controller.setSetting('scanMs', '30'); controller.setSetting('intervalMs', '1.2');
  controller.start(); await settle();
  for (let i = 0; i < 24 * 120; i++) {
    t.mock.timers.tick(30000); await settle();
    assert.equal(controller.getSnapshot().expansion.running, true);
    assert.equal(controller.getSnapshot().uncertain, false);
    assert.ok(controller.getSnapshot().logs.length <= 50);
  }
  assert.ok(launches > 2000, `automation kept progressing: ${launches} requests`);
  controller.stop(); t.mock.timers.tick(15000); await settle();
  controller.dispose(); await withControl(async () => {});
  assert.equal((f.world.dispose as any).mock.callCount(), 1);
});
