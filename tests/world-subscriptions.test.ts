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

test('diagnostics distinguish slow native memory quotations from actual inventory subscriptions', async t => {
  const f = setup(); t.after(() => f.world.dispose());
  await f.world.scan(defaults, () => true);
  let time = 0; t.mock.method(performance, 'now', () => time);
  f.native.mock.mockImplementation(() => { time += 12; return { travelMs: 200000, lossPct: 0, outOfRange: false, exact: { reason: 'capture', probes: 8 } }; });
  f.queries.length = 0;
  f.world.read(); f.world.route(1n, 2n); f.world.quote(1n, 2n);
  assert.equal(f.world.diagnostics().quoteCalls, 1, 'route and capture share one native call per slice');
  assert.equal(f.world.diagnostics().quoteMs, 12); assert.equal(f.world.diagnostics().quoteMaxMs, 12);
  assert.equal(f.world.diagnostics().slowQuotes, 1); assert.equal(f.queries.length, 0);
  assert.equal(f.world.diagnostics().readCalls, 1);
  f.onQuery(() => { time += 50; });
  await f.world.syncInventory([1n, 1n]);
  assert.equal(f.world.diagnostics().syncCalls, 1); assert.equal(f.world.diagnostics().syncQueries, 1);
  assert.equal(f.world.diagnostics().syncMs, 50); assert.equal(f.world.diagnostics().syncTotalMs, 50);
  assert.equal(f.world.diagnostics().syncActive, 0); assert.equal(f.queries.length, 1);
});

test('meteorite skip diagnostics reuse the native quote and expose its rejected requirement', async t => {
  const f = setup(); t.after(() => f.world.dispose());
  await f.world.scan(defaults, () => true);
  f.native.mock.mockImplementation(() => ({ travelMs: 200000, lossPct: 10, outOfRange: true, exact: { reason: 'capture', probes: 800 } }));
  assert.equal(f.world.quoteBody(1n, 2n, 'comet'), null);
  assert.match(f.world.bodyQuoteIssue(1n, 2n, 'comet')!, /航时 200 秒、损耗 10%、原生需 800 探针/);
  assert.equal(f.native.mock.callCount(), 1, 'diagnostic text must not issue a second quote');
});

test('native quote dependency version follows technology, galaxy geometry and active coverage rather than unrelated stock', async t => {
  const f = setup(); t.after(() => f.world.dispose());
  const tech = { playerId: f.owner, assault: 10 };
  const base = { baseId: 10n, ownerId: f.owner, positionX: 0, positionY: 0, level: 1, superprobes: 2 };
  const sun = { sunId: 20n, ownerId: f.owner, positionX: 1, positionY: 1, galaxyId: 1n, probeCount: 20 };
  const galaxy = { id: 1n, x: 0, y: 0 };
  Object.assign(f.session.conn.db, { player_tech: { iter: () => [tech] }, base: { iter: () => [base] },
    sun2: { iter: () => [sun] }, galaxy: { iter: () => [galaxy] } });
  await f.world.scan(defaults, () => true);
  const initial = f.world.read(); assert.equal(initial.attackMultiplierUpperBound, 1.1);
  base.superprobes = 1; sun.probeCount++;
  assert.equal(f.world.read().quoteVersion, initial.quoteVersion);
  base.superprobes = 0;
  const inactive = f.world.read().quoteVersion; assert.notEqual(inactive, initial.quoteVersion);
  tech.assault++;
  const upgraded = f.world.read().quoteVersion; assert.notEqual(upgraded, inactive);
  galaxy.x++;
  assert.notEqual(f.world.read().quoteVersion, upgraded);
});

test('SDK iterator reordering does not invalidate quotes, while actual coverage changes do', async t => {
  const f = setup(); t.after(() => f.world.dispose());
  const bases = [1n, 2n].map(baseId => ({ baseId, ownerId: f.owner, positionX: Number(baseId), positionY: 0, superprobes: 1 }));
  const suns = [3n, 4n].map(sunId => ({ sunId, ownerId: f.owner, positionX: Number(sunId), positionY: 0, galaxyId: 1n, probeCount: 20 }));
  const galaxies = [{ id: 1n, x: 0 }, { id: 2n, x: 10 }];
  const clans = [{ playerId: f.owner, clanId: 1n }, { playerId: { toHexString: () => '1'.repeat(64) }, clanId: 1n }];
  Object.assign(f.session.conn.db, { base: { iter: () => bases }, sun2: { iter: () => suns }, galaxy: { iter: () => galaxies }, clan_member2: { iter: () => clans } });
  await f.world.scan(defaults, () => true);
  const before = f.world.read().quoteVersion;
  for (const rows of [bases, suns, galaxies, clans]) rows.reverse();
  assert.equal(f.world.read().quoteVersion, before);
  bases[0].superprobes = 0;
  assert.notEqual(f.world.read().quoteVersion, before);
});

test('source quote rules isolate influence changes and still invalidate technology and galaxy changes', async t => {
  const f = setup(); t.after(() => f.world.dispose());
  f.target.ownerId = f.owner; f.target.positionX = 40;
  const tech = { playerId: f.owner, velocity: 10 };
  const near = { baseId: 10n, ownerId: f.owner, positionX: 0, positionY: 0, level: 1, superprobes: 1 };
  const far = { ...near, baseId: 11n, positionX: 1000 };
  const galaxy = { id: 1n, x: 0, y: 0 };
  Object.assign(f.session.conn.db, { player_tech: { iter: () => [tech] }, base: { iter: () => [near, far] }, galaxy: { iter: () => [galaxy] } });
  await f.world.scan(defaults, () => true);
  const initial = f.world.read();
  far.superprobes = 0; const distant = f.world.read();
  assert.notEqual(distant.quoteVersion, initial.quoteVersion);
  assert.equal(distant.quoteGlobalVersion, initial.quoteGlobalVersion);
  assert.deepEqual(distant.sourceQuoteVersions, initial.sourceQuoteVersions);
  near.superprobes = 0; const local = f.world.read();
  assert.notEqual(local.sourceQuoteVersions!.get(1n), initial.sourceQuoteVersions!.get(1n));
  assert.equal(local.sourceQuoteVersions!.get(2n), initial.sourceQuoteVersions!.get(2n));
  tech.velocity++; const upgraded = f.world.read();
  for (const id of [1n, 2n]) assert.notEqual(upgraded.sourceQuoteVersions!.get(id), local.sourceQuoteVersions!.get(id));
  galaxy.x++; assert.notEqual(f.world.read().quoteGlobalVersion, upgraded.quoteGlobalVersion);
});

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

test('production forecasts and repeated native quotes read SDK memory without new subscriptions', async t => {
  const f = setup(); t.after(() => f.world.dispose());
  const tech = { playerId: f.owner, construction: 200 };
  const sun = { sunId: 20n, ownerId: f.owner, positionX: 8, positionY: 0, galaxyId: 1n, probeCount: 20 };
  const base = { baseId: 30n, ownerId: f.owner, positionX: 1, positionY: 0, level: 1, superprobes: 1 };
  Object.assign(f.session.conn.db, { player_tech: { iter: () => [tech] }, sun2: { iter: () => [sun] }, base: { iter: () => [base] } });
  await f.world.scan(defaults, () => true);
  const subscriptions = f.queries.length;
  assert.equal(f.world.read().productionTicks!.get(1n), 30000);
  sun.positionX = 9; base.superprobes = 0;
  assert.equal(f.world.read().productionTicks!.get(1n), 60000);
  base.superprobes = 1;
  assert.equal(f.world.read().productionTicks!.get(1n), 30000);
  tech.construction = 0;
  assert.equal(f.world.read().productionTicks!.get(1n), 60000);
  for (let i = 0; i < 10; i++) { f.world.read(); f.world.refreshQuotes(); f.world.quote(1n, 2n); }
  assert.equal(f.queries.length, subscriptions);
  assert.ok(f.world.diagnostics().quoteCalls >= 10);
  await f.world.scan(defaults, () => true);
  assert.equal(f.world.diagnostics().newSubscriptions, 0);
  assert.ok(f.world.diagnostics().reusedSubscriptions > 0);
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

test('default expansion scans the live meteorite2 table without a meteorite alias', async t => {
  const f = setup(); t.after(() => f.world.dispose());
  const meteorite = { meteoriteId: 7n, positionX: 3, positionY: 0, galaxyId: 1n, probeCount: 1, expiresAt: { toMillis: () => Date.now() + 3600000 } };
  assert.equal('meteorite' in f.session.conn.db, false);
  f.session.conn.db.meteorite2 = { iter: () => [meteorite] };
  f.onQuery(query => assert.doesNotMatch(query, /FROM meteorite\b/, 'Meteorite is a row type; the live SQL table is meteorite2'));
  await f.world.scan(defaults, () => true);
  assert.ok(f.queries.some(query => query.startsWith('SELECT * FROM meteorite2 WHERE')));
  const snapshot = f.world.read();
  assert.deepEqual(snapshot.meteorites, [meteorite]);
  assert.equal(snapshot.owned.length, 1);
  assert.equal(f.launchSwarm.mock.callCount(), 0);
});

test('missing meteorite2 data blocks meteorite capture but not scans with that feature disabled', async t => {
  const f = setup(); t.after(() => f.world.dispose());
  delete f.session.conn.db.meteorite2;
  await assert.rejects(f.world.scan(defaults, () => true), /陨石情报接口不可用/);
  assert.equal(f.queries.length, 0);
  const settings = { ...defaults, captureMeteorites: 0 };
  f.world.configure([{ settings, policy: { ...defaultPolicy } }]);
  await f.world.scan(settings, () => true);
  assert.ok(f.queries.every(query => !query.includes('meteorite')));
  assert.equal(f.world.read().owned.length, 1);
  assert.equal(f.launchSwarm.mock.callCount(), 0);
});

test('native bulk upgrades preserve bigint ids and reject duplicate or oversized batches without fallback', async t => {
  const f = setup(); t.after(() => f.world.dispose());
  const calls: bigint[][] = [];
  f.session.conn.reducers.upgradePlanetsBulk = async ({ planetIds }) => { calls.push(planetIds); };
  const ids = [1n, 9007199254740993n];
  await f.world.upgradeMany(ids);
  assert.deepEqual(calls, [ids]);
  assert.throws(() => f.world.upgradeMany([1n, 1n]), /不同星球/);
  assert.throws(() => f.world.upgradeMany(Array.from({ length: 201 }, (_, i) => BigInt(i))), /200/);
  delete f.session.conn.reducers.upgradePlanetsBulk;
  assert.throws(() => f.world.upgradeMany(ids), /接口不可用/);
  assert.equal(calls.length, 1);
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
    meteorite2: { iter: () => [{ meteoriteId: 2n, positionX: 3, positionY: 0, galaxyId: 1n, probeCount: 1, expiresAt: { toMillis: () => Date.now() + 3600000 } }] },
    swarm: { iter: () => [{ swarmId: 1n, ownerId: foe, targetPlanetId: 0n, targetSunId: 2n }, { swarmId: 2n, ownerId: foe, targetPlanetId: 0n, targetMeteoriteId: 2n }] },
    sun_swarm2: { iter: () => [{ swarmId: 1n, ownerId: foe, targetSunId: 2n, targetBlackHole: false }] },
  });
  await f.world.scan(defaults, () => true);
  const snapshot = f.world.read();
  assert.ok(f.queries.some(q => q.startsWith('SELECT * FROM meteorite2 WHERE')));
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
  assert.deepEqual(calls, [['sun', { sourcePlanetId: 1n, targetSunId: 2n, probeCount: 100n }], ['comet', { sourcePlanetId: 1n, targetMeteoriteId: 2n, probeCount: 100n }], ['upgrade', { planetId: 1n }]]);
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
