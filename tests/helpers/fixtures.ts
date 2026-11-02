import { mock } from 'node:test';
import type { Connection, Planet, Subscription } from '../../src/game/types';
import type { ExpansionWorld, WorldSnapshot } from '../../src/features/expansion/world';

export const identity = { toHexString: () => 'me' };
export function planet(id: bigint, x: number, y: number, owned = false): Planet {
  return { planetId: id, positionX: x, positionY: y, probeCount: 20, galaxyId: 1n, ownerId: owned ? identity : undefined };
}
export function fixture(rows: Planet[]) {
  const handles: Subscription[] = [];
  const launchSwarm = mock.fn(async () => {});
  const conn: Connection = {
    isActive: true,
    db: { planet: { iter: () => rows, planetId: { find: id => rows.find(p => p.planetId === id) } }, meteorite: { iter: () => [] }, sun_swarm2: { iter: () => [] } },
    reducers: { launchSwarm },
    subscriptionBuilder: () => {
      let applied = () => {};
      const builder = {
        onApplied(fn: () => void) { applied = fn; return builder; }, onError() { return builder; },
        subscribe() {
          let active = true;
          const handle = { unsubscribe: mock.fn(() => { active = false; }), isActive: () => active };
          handles.push(handle); queueMicrotask(applied); return handle;
        },
      };
      return builder;
    },
  };
  const canvas = document.createElement('canvas');
  Object.assign(canvas, { '__reactFiber$fixture': { return: { memoizedProps: { conn, myIdentity: 'me' } } } });
  document.body.append(canvas);
  return { session: { conn, identity: 'me' }, handles, launchSwarm };
}
export const settle = () => new Promise(resolve => setImmediate(resolve));

export function fakeWorld() {
  const source = planet(1n, 0, 0, true), target = planet(2n, 1, 0);
  const snapshot: WorldSnapshot = { planets: [source, target], owned: [source], budgets: new Map([[1n, 20]]), incoming: new Set() };
  const world: ExpansionWorld = {
    scan: mock.fn(async () => {}), read: () => snapshot,
    quote: () => ({ count: 12, travelMs: 1000 }),
    launch: mock.fn(async () => {}), dispose: mock.fn(),
  };
  return { world, snapshot, source, target };
}
export function coalitionWorld(size = 2) {
  const f = fakeWorld(); f.target.probeCount = 10;
  for (let i = 1; i < size; i++) {
    const p = planet(BigInt(3 + i), 0, i, true);
    f.snapshot.planets.push(p); f.snapshot.owned.push(p);
  }
  for (const p of f.snapshot.owned) f.snapshot.budgets.set(p.planetId, size === 3 ? 5 : 8);
  f.world.quote = () => null; // Each source lacks the native single-source capture quote.
  f.world.route = () => ({ travelMs: 10000, lossPct: 0 });
  f.world.launchGroup = mock.fn(async () => {});
  return f;
}
