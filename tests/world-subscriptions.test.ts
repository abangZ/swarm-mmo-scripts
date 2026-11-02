import './helpers/browser';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, planet } from './helpers/fixtures';
import { GameWorld } from '../src/game/expansion-world';
import { defaults } from '../src/features/expansion/types';
import { defaultPolicy } from '../src/features/commander/types';

function setup() {
  const identity = '0'.repeat(64), owner = { toHexString: () => identity };
  const source = planet(1n, 0, 0, true), target = planet(2n, 1, 0);
  source.ownerId = owner;
  const f = fixture([source, target]), queries: string[] = [];
  let onQuery = (_query: string) => {};
  const builder = f.session.conn.subscriptionBuilder;
  f.session.conn.subscriptionBuilder = () => {
    const result = builder(), subscribe = result.subscribe.bind(result);
    result.subscribe = query => { queries.push(query); onQuery(query); return subscribe(query); };
    return result;
  };
  Object.assign(f.session.conn.db, Object.fromEntries(['swarm', 'clan_member2', 'player_tech', 'sun2', 'base', 'attack_automation', 'upgrade_automation', 'player'].map(key => [key, { iter: () => [] }])));
  const native = mock.fn(() => ({ travelMs: 200000, lossPct: 0, outOfRange: false, exact: { reason: 'capture', probes: 8 } }));
  const canvas = document.querySelector('canvas') as unknown as Record<string, any>;
  const props = canvas['__reactFiber$fixture'].return.memoizedProps;
  props.myIdentity = identity;
  props.ref = { current: { quoteSend: native, listOwnedBodies: () => [source, target].filter(p => p.ownerId).map(p => ({ kind: 'planet', id: p.planetId, probes: 20 })) } };
  const world = new GameWorld(); world.configure([{ settings: defaults, policy: { ...defaultPolicy } }]);
  return { ...f, world, queries, source, target, owner, native, onQuery: (fn: typeof onQuery) => { onQuery = fn; } };
}

test('unchanged scans reuse live subscriptions and covered captures become sources without a network reload', async t => {
  const f = setup(); t.after(() => f.world.dispose());
  await f.world.scan(defaults, () => true);
  const count = f.handles.length; f.queries.length = 0;
  assert.equal(f.world.needsScan(), false);
  for (let i = 0; i < 3; i++) await f.world.scan(defaults, () => true);
  assert.equal(f.queries.length, 0); assert.equal(f.handles.length, count);
  assert.ok(f.handles.every(h => h.isActive()));
  f.target.ownerId = f.owner;
  assert.equal(f.world.needsScan(), true);
  await f.world.scan(defaults, () => true);
  assert.deepEqual(f.world.read().owned.map(p => p.planetId), [1n, 2n]);
  assert.equal(f.world.needsScan(), false); assert.equal(f.queries.length, 0);
  assert.equal(f.launchSwarm.mock.callCount(), 0);
});

test('cancelled coverage extension releases only new subscriptions and retains the previously active set', async t => {
  const f = setup(); t.after(() => f.world.dispose());
  await f.world.scan(defaults, () => true);
  const old = f.handles.length;
  let alive = true; f.onQuery(() => { alive = false; });
  f.world.configure([{ settings: defaults, policy: { ...defaultPolicy, zone: { x: 500, y: 0, radius: 8 } } }]);
  await assert.rejects(f.world.scan(defaults, () => alive), /停止/);
  assert.ok(f.handles.length > old);
  assert.ok(f.handles.slice(0, old).every(h => h.isActive()));
  assert.ok(f.handles.slice(old).every(h => !h.isActive()));
});

test('native quote and route are reused within a snapshot but refreshed before the next execution snapshot', async t => {
  const f = setup(); t.after(() => f.world.dispose());
  await f.world.scan(defaults, () => true); f.world.read();
  f.world.quote(1n, 2n); f.world.route(1n, 2n); f.world.quote(1n, 2n);
  assert.equal(f.native.mock.callCount(), 1);
  f.world.read(); f.world.quote(1n, 2n);
  assert.equal(f.native.mock.callCount(), 2);
  f.world.refreshQuotes(); f.world.quote(1n, 2n); f.world.route(1n, 2n);
  assert.equal(f.native.mock.callCount(), 3, 'a resumed browser slice must use a new native quote cache');
  f.handles[0].unsubscribe();
  await assert.rejects(f.world.scan(defaults, () => true), /订阅已失效/);
  assert.throws(() => f.world.read(), /订阅已失效/);
});

test('special targets use separate native quotes, target fleet tables and reducers even when numeric ids collide', async t => {
  const f = setup(); t.after(() => f.world.dispose());
  const calls: unknown[] = [];
  Object.assign(f.session.conn.reducers, {
    launchSwarmAtSun: async (args: unknown) => { calls.push(['sun', args]); },
    launchSwarmAtMeteorite: async (args: unknown) => { calls.push(['comet', args]); },
    upgradePlanet: async (args: unknown) => { calls.push(['upgrade', args]); },
  });
  const foe = { toHexString: () => 'enemy' };
  Object.assign(f.session.conn.db, {
    sun2: { iter: () => [{ sunId: 2n, positionX: 2, positionY: 0, galaxyId: 1n, probeCount: 0 }] },
    meteorite: { iter: () => [{ meteoriteId: 2n, positionX: 3, positionY: 0, galaxyId: 1n, probeCount: 1, expiresAt: { toMillis: () => Date.now() + 3600000 } }] },
    swarm: { iter: () => [{ swarmId: 1n, ownerId: foe, targetPlanetId: 0n, targetSunId: 2n }, { swarmId: 2n, ownerId: foe, targetPlanetId: 0n, targetMeteoriteId: 2n }] },
    sun_swarm2: { iter: () => [{ swarmId: 1n, ownerId: foe, targetSunId: 2n, targetBlackHole: false }] },
  });
  await f.world.scan(defaults, () => true);
  const snapshot = f.world.read();
  assert.ok(f.queries.some(q => q.startsWith('SELECT * FROM meteorite WHERE')));
  assert.ok(f.queries.some(q => q.startsWith('SELECT * FROM sun_swarm2 WHERE') && q.includes('target_x')));
  assert.equal(snapshot.fleets!.length, 0); assert.equal(snapshot.bodyFleets!.get('sun:2')!.length, 2); assert.equal(snapshot.bodyFleets!.get('comet:2')!.length, 1);
  f.native.mock.mockImplementation(() => ({ travelMs: 2000, lossPct: 0, outOfRange: false, exact: { reason: 'capture', probes: 100 } }));
  assert.equal(f.world.quoteBody(1n, 2n, 'sun')!.count, 100, 'sun quote is already denominated in launch probes, not super-probes');
  assert.equal(f.world.quoteBody(1n, 2n, 'comet')!.count, 101);
  assert.equal(f.world.quote(1n, 2n)!.count, 101);
  assert.equal(f.native.mock.callCount(), 3);
  assert.deepEqual(f.native.mock.calls.map(c => c.arguments), [['planet', 1n, 'sun', 2n], ['planet', 1n, 'comet', 2n], ['planet', 1n, 'planet', 2n]]);
  const job = { sourceId: 1n, targetId: 2n, count: 100, travelMs: 2000 };
  await f.world.launchBody({ ...job, targetKind: 'sun' }); await f.world.launchBody({ ...job, targetKind: 'comet' }); await f.world.upgrade(1n);
  assert.deepEqual(calls, [['sun', { sourcePlanetId: 1n, targetSunId: 2n, probeCount: 100 }], ['comet', { sourcePlanetId: 1n, targetMeteoriteId: 2n, probeCount: 100 }], ['upgrade', { planetId: 1n }]]);
});

test('420-source edge growth preserves full coverage batches instead of rechunking unchanged tiles', async t => {
  const identity = '0'.repeat(64), owner = { toHexString: () => identity };
  const owned = Array.from({ length: 420 }, (_, i) => {
    const p = planet(BigInt(i + 1), (i % 30 - 15) * 8, (Math.floor(i / 30) - 7) * 8); p.ownerId = owner; return p;
  });
  const edge = planet(1000n, -151, 0), rows = [...owned, edge];
  const f = fixture(rows), queries: string[] = [], builder = f.session.conn.subscriptionBuilder;
  f.session.conn.subscriptionBuilder = () => {
    const result = builder(), subscribe = result.subscribe.bind(result);
    result.subscribe = query => { queries.push(query); return subscribe(query); }; return result;
  };
  Object.assign(f.session.conn.db, Object.fromEntries(['swarm', 'clan_member2', 'player_tech', 'sun2', 'base', 'attack_automation', 'upgrade_automation', 'player'].map(key => [key, { iter: () => [] }])));
  const props = (document.querySelector('canvas') as any)['__reactFiber$fixture'].return.memoizedProps;
  props.myIdentity = identity;
  props.ref = { current: { quoteSend: () => null, listOwnedBodies: () => rows.filter(p => p.ownerId).map(p => ({ kind: 'planet', id: p.planetId, probes: 20 })) } };
  const world = new GameWorld(), settings = { ...defaults, radius: 64, captureSuns: 0, captureMeteorites: 0 };
  t.after(() => world.dispose()); world.configure([{ settings, policy: { ...defaultPolicy } }]);
  await world.scan(settings, () => true);
  const firstCount = f.handles.length;
  assert.equal(firstCount, 27);
  await world.scan(settings, () => true); assert.equal(f.handles.length, firstCount);
  edge.ownerId = owner;
  await world.scan(settings, () => true);
  assert.equal(f.handles.length - firstCount, 8);
  assert.equal(f.handles.slice(0, firstCount).filter(h => !h.isActive()).length, 4);
  assert.equal(f.handles.filter(h => h.isActive()).length, 31);
  assert.equal(world.read().owned.length, 421);
  world.dispose(); assert.equal(f.handles.filter(h => h.isActive()).length, 0);
});
