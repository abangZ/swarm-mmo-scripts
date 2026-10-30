import { distance } from '../shared/distance';
import { nearestUnowned, validateLaunch } from '../features/manual/nearest';
import type { Session } from './types';
import { getSession } from './session';
import { subscribe } from './subscriptions';

export interface SearchResult { session: Session; sourceId: bigint; targetId: bigint; radius: number; release(): void; active(): boolean }
export async function findNearest(session: Session, sourceId: bigint, alive: () => boolean = () => true): Promise<SearchResult> {
  const source = session.conn.db.planet.planetId.find(sourceId);
  if (!source || source.ownerId?.toHexString() !== session.identity) throw new Error('请选择自己的星球。');
  // A candidate inside the inscribed circle is nearer than every point outside the loaded square.
  for (const radius of [16, 32, 64, 128, 256, 512, 1024]) {
    if (!alive()) throw new Error('搜索已取消。');
    const x = source.positionX, y = source.positionY;
    const handle = await subscribe(session.conn, `SELECT * FROM planet WHERE position_x >= ${x - radius} AND position_x <= ${x + radius} AND position_y >= ${y - radius} AND position_y <= ${y + radius}`);
    if (!alive()) { handle.unsubscribe(); throw new Error('搜索已取消。'); }
    const target = nearestUnowned(source, session.conn.db.planet.iter());
    if (target && distance(source, target) < radius) {
      return { session, sourceId, targetId: target.planetId, radius, release: () => handle.unsubscribe(), active: () => handle.isActive() };
    }
    handle.unsubscribe();
  }
  throw new Error('搜索半径 1024 内未能确认最近的无主行星；未发送探针。');
}
export function prepareSend(result: SearchResult, count: number): () => Promise<void> {
  const current = getSession();
  if (current.conn !== result.session.conn || current.identity !== result.session.identity || !result.active()) throw new Error('连接或订阅已变化，请重新搜索。');
  const source = current.conn.db.planet.planetId.find(result.sourceId);
  const target = current.conn.db.planet.planetId.find(result.targetId);
  validateLaunch(source, target, current.identity, count);
  const nearest = nearestUnowned(source!, current.conn.db.planet.iter());
  if (nearest?.planetId !== result.targetId || distance(source!, target!) >= result.radius) throw new Error('最近目标已变化，请重新搜索。');
  return () => current.conn.reducers.launchSwarm({ sourcePlanetId: result.sourceId, targetPlanetId: result.targetId, probeCount: count });
}

export async function send(result: SearchResult, count: number): Promise<void> { await prepareSend(result, count)(); }
