import './helpers/browser';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { GameWorld, safeQuote } from '../src/game/expansion-world';
import { getAutomationSession } from '../src/game/session';
import { subscribe } from '../src/game/subscriptions';
import { fixture } from './helpers/fixtures';

test('capture quote always adds two including re-quotes, and rejects invalid quotes', () => {
  assert.deepEqual(safeQuote({ travelMs: 2000, lossPct: 0, outOfRange: false, exact: { reason: 'capture', probes: 8 } }), { count: 10, travelMs: 2000 });
  assert.equal(safeQuote({ travelMs: 2, lossPct: 0, outOfRange: false, exact: { reason: 'levelUp', probes: 8 } }), null);
  assert.equal(safeQuote({ travelMs: 2, lossPct: 0, outOfRange: false, exact: { reason: 'capture', probes: 0xffffffff } }), null);
});
test('controller discovery uses the map ref and requires fleet access', () => {
  const f = fixture([]);
  f.session.conn.db.swarm = { iter: () => [] };
  const canvas = document.querySelector('canvas') as unknown as Record<string, any>;
  const map = { quoteSend() { return null; }, listOwnedBodies() { return []; } };
  canvas['__reactFiber$fixture'].return.memoizedProps.ref = { current: map };
  assert.equal(getAutomationSession().map, map);
});
test('game adapter uses native bulk launch and can read routes without a single-source quote', async () => {
  const f = fixture([]); f.session.conn.db.swarm = { iter: () => [] };
  f.session.conn.reducers.launchSwarmBulk = mock.fn(async () => {});
  const canvas = document.querySelector('canvas') as unknown as Record<string, any>;
  canvas['__reactFiber$fixture'].return.memoizedProps.ref = { current: {
    quoteSend: () => ({ travelMs: 12000, lossPct: 25, outOfRange: true }),
    listOwnedBodies: () => [],
  } };
  const world = new GameWorld();
  assert.deepEqual(world.route(1n, 10n), { travelMs: 12000, lossPct: 25 });
  assert.equal(world.quote(1n, 10n), null);
  await world.launchGroup({ sourceId: 1n, targetId: 10n, count: 8, travelMs: 12000, support: [{ sourceId: 2n, count: 9, travelMs: 12000 }] });
  assert.deepEqual((f.session.conn.reducers.launchSwarmBulk as any).mock.calls[0].arguments[0], { kind: 0, targetId: 10n, launches: [{ sourceId: 1n, probeCount: 8 }, { sourceId: 2n, probeCount: 9 }] });
});

test('query timeout unsubscribes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture([]), unsubscribe = mock.fn();
  f.session.conn.subscriptionBuilder = () => {
    const builder = { onApplied: () => builder, onError: () => builder, subscribe: () => ({ unsubscribe, isActive: () => false }) };
    return builder;
  };
  const pending = assert.rejects(subscribe(f.session.conn, 'SELECT * FROM planet'), /超时/);
  t.mock.timers.tick(12000); await pending;
  assert.equal(unsubscribe.mock.callCount(), 1);
});
