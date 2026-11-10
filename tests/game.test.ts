import './helpers/browser';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { GameWorld, safeQuote } from '../src/game/expansion-world';
import { getAutomationSession } from '../src/game/session';
import { subscribe } from '../src/game/subscriptions';
import { fixture, planet } from './helpers/fixtures';

test('native auto-upgrade shutdown targets only the owned gathering planet and validates session', async () => {
  const hub = planet(9007199254740993n, 0, 0, true), f = fixture([hub]);
  f.session.conn.db.swarm = { iter: () => [] };
  const canvas = document.querySelector('canvas') as unknown as Record<string, any>;
  canvas['__reactFiber$fixture'].return.memoizedProps.ref = { current: { quoteSend: () => null, listOwnedBodies: () => [] } };
  const disable = f.session.conn.reducers.setUpgradeAutomationBulk = mock.fn(async () => {});
  const world = new GameWorld();
  await world.disableAutoUpgrade(hub.planetId);
  assert.deepEqual(disable.mock.calls.map(call => call.arguments), [[{ planetIds: [hub.planetId], enable: false }]]);
  hub.ownerId = undefined;
  assert.throws(() => world.disableAutoUpgrade(hub.planetId), /所有权/);
  hub.ownerId = { toHexString: () => 'me' };
  delete f.session.conn.reducers.setUpgradeAutomationBulk;
  assert.throws(() => world.disableAutoUpgrade(hub.planetId), /接口不可用/);
  canvas['__reactFiber$fixture'].return.memoizedProps.myIdentity = 'other';
  assert.throws(() => world.disableAutoUpgrade(hub.planetId), /身份已变化/);
  assert.equal(disable.mock.callCount(), 1);
});

test('capture quote preserves the native winning count and rejects invalid quotes', () => {
  assert.deepEqual(safeQuote({ travelMs: 2000, lossPct: 0, outOfRange: false, exact: { reason: 'capture', probes: 8 } }), { count: 8, travelMs: 2000 });
  assert.equal(safeQuote({ travelMs: 2, lossPct: 0, outOfRange: false, exact: { reason: 'levelUp', probes: 8 } }), null);
  assert.equal(safeQuote({ travelMs: 2, lossPct: 0, outOfRange: false, exact: { reason: 'capture', probes: 0x100000000 } }), null);
});
test('controller discovery uses the map ref and requires fleet access', () => {
  const f = fixture([]);
  f.session.conn.db.swarm = { iter: () => [] };
  const canvas = document.querySelector('canvas') as unknown as Record<string, any>;
  const map = { quoteSend() { return null; }, listOwnedBodies() { return []; } };
  canvas['__reactFiber$fixture'].return.memoizedProps.ref = { current: map };
  assert.equal(getAutomationSession().map, map);
});
test('game adapter can read routes without a single-source quote', async () => {
  const f = fixture([]); f.session.conn.db.swarm = { iter: () => [] };
  const canvas = document.querySelector('canvas') as unknown as Record<string, any>;
  canvas['__reactFiber$fixture'].return.memoizedProps.ref = { current: {
    quoteSend: () => ({ travelMs: 12000, lossPct: 25, outOfRange: true }),
    listOwnedBodies: () => [],
  } };
  const world = new GameWorld();
  assert.deepEqual(world.route(1n, 10n), { travelMs: 12000, lossPct: 25 });
  assert.equal(world.quote(1n, 10n), null);
});

test('single and bulk launches send bigint probe counts to the native reducers', async () => {
  const f = fixture([]);
  f.session.conn.db.swarm = { iter: () => [] };
  const canvas = document.querySelector('canvas') as unknown as Record<string, any>;
  canvas['__reactFiber$fixture'].return.memoizedProps.ref = { current: {
    quoteSend: () => null, listOwnedBodies: () => [],
  } };
  const bulk = mock.fn(async () => {});
  f.session.conn.reducers.launchSwarmBulk = bulk;
  const world = new GameWorld();
  await world.launch(1n, 4253062n, 6);
  assert.deepEqual(f.launchSwarm.mock.calls.map(call => call.arguments), [
    [{ sourcePlanetId: 1n, targetPlanetId: 4253062n, probeCount: 6n }],
  ]);

  await world.launchGroup({ sourceId: 1n, targetId: 10n, count: 8, travelMs: 12000, support: [{ sourceId: 2n, count: 9, travelMs: 12000 }] });
  assert.deepEqual(bulk.mock.calls.map(call => call.arguments), [
    [{ kind: 0, targetId: 10n, launches: [{ sourceId: 1n, probeCount: 8n }, { sourceId: 2n, probeCount: 9n }] }],
  ]);
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

test('regional adapter subscribes threats and technology locally, without expanding around distant owned planets', async () => {
  const me = '0'.repeat(64), enemy = 'a'.repeat(64);
  const own = { toHexString: () => me }, other = { toHexString: () => enemy };
  const rows = [
    { planetId: 1n, positionX: 0, positionY: 0, probeCount: 100, galaxyId: 1n, ownerId: own },
    { planetId: 2n, positionX: 1, positionY: 0, probeCount: 20, galaxyId: 1n, ownerId: other },
    { planetId: 99n, positionX: 10000, positionY: 10000, probeCount: 100, galaxyId: 2n, ownerId: own },
  ];
  const f = fixture(rows), queries: string[] = [];
  const original = f.session.conn.subscriptionBuilder;
  f.session.conn.subscriptionBuilder = () => {
    const builder = original(), subscribe = builder.subscribe.bind(builder);
    builder.subscribe = query => { queries.push(query); return subscribe(query); }; return builder;
  };
  Object.assign(f.session.conn.db, {
    swarm: { iter: () => [{ swarmId: 1n, ownerId: other, targetPlanetId: 1n, sourceX: 1, sourceY: 0, probeCount: 30, arrivalTime: { toMillis: () => 200000 } }] },
    clan_member2: { iter: () => [] }, player_tech: { iter: () => [] }, sun2: { iter: () => [] }, base: { iter: () => [] },
    attack_automation: { iter: () => [{ sourcePlanetId: 1n }] }, upgrade_automation: { iter: () => [{ planetId: 99n }] },
    player: { iter: () => [{ identity: other, username: '邻居' }] },
  });
  const canvas = document.querySelector('canvas') as unknown as Record<string, any>;
  const props = canvas['__reactFiber$fixture'].return.memoizedProps;
  props.myIdentity = me;
  props.ref = { current: { quoteSend: () => null, listOwnedBodies: () => [{ kind: 'planet', id: 1n, probes: 100 }, { kind: 'planet', id: 99n, probes: 100 }] } };
  const { defaults } = await import('../src/features/expansion/types');
  const { defaultPolicy } = await import('../src/features/commander/types');
  const world = new GameWorld();
  world.configure([{ settings: defaults, policy: { ...defaultPolicy, zone: { x: 0, y: 0, radius: 8 } } }]);
  await world.scan(defaults, () => true);
  const snapshot = world.read();
  assert.deepEqual(snapshot.owned.map(p => p.planetId), [1n]);
  assert.equal(snapshot.allOwned!.length, 2);
  assert.ok(queries.some(q => q.startsWith('SELECT * FROM swarm WHERE') && q.includes('target_x')));
  assert.ok(queries.some(q => q.startsWith('SELECT * FROM sun2 WHERE')));
  assert.ok(queries.some(q => q.startsWith('SELECT * FROM base WHERE')));
  assert.ok(queries.some(q => q.includes('SELECT * FROM player WHERE') && q.includes(enemy)));
  assert.equal(queries.some(q => q.includes('10000')), false);
  assert.equal(snapshot.fleets![0].owner, enemy);
  assert.equal(snapshot.fleets![0].arriving, 30);
  assert.equal(snapshot.players!.get(enemy), '邻居');
  assert.equal(snapshot.automated!.has(99n), false);
  assert.equal(snapshot.automated!.has(1n), true);
  assert.equal(snapshot.autoUpgrading!.has(99n), true);
  assert.equal(snapshot.intelligence, true);
  queries.length = 0;
  await world.syncInventory([1n, 1n, 99n]);
  assert.deepEqual(queries, ['SELECT * FROM planet WHERE planet_id = 1 OR planet_id = 99']);
  assert.equal(f.handles.at(-1)!.isActive(), false);
  assert.equal(f.handles[0].isActive(), true, 'normal subscriptions remain active after the temporary inventory barrier');
  world.dispose(); assert.ok(f.handles.every(h => !h.isActive()));
});
