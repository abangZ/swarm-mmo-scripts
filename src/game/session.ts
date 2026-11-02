import type { Connection, Planet, Session, AutomationSession, MapController } from './types';

interface Fiber { memoizedProps?: { conn?: Connection; myIdentity?: string; ref?: { current?: MapController } }; ref?: { current?: MapController }; return?: Fiber }
// Connection discovery through React internals stays in the game adapter layer.
export function getSession(): Session {
  for (const canvas of document.querySelectorAll('canvas')) {
    const key = Object.keys(canvas).find(key => key.startsWith('__reactFiber$'));
    let fiber = key ? (canvas as unknown as Record<string, Fiber>)[key] : undefined;
    for (let depth = 0; fiber && depth < 80; depth++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      const conn = props?.conn;
      if (conn?.isActive && typeof conn.db?.planet?.iter === 'function' && typeof conn.reducers?.launchSwarm === 'function' && props?.myIdentity) {
        return { conn, identity: props.myIdentity };
      }
    }
  }
  throw new Error('未连接游戏。请进入星系地图后刷新；若仍失败，游戏版本可能已变化。');
}
export function ownedPlanets(session: Session): Planet[] {
  return [...session.conn.db.planet.iter()].filter(p => p.ownerId?.toHexString() === session.identity)
    .sort((a, b) => a.planetId < b.planetId ? -1 : a.planetId > b.planetId ? 1 : 0);
}
export function getAutomationSession(): AutomationSession {
  const session = getSession();
  for (const canvas of document.querySelectorAll('canvas')) {
    const key = Object.keys(canvas).find(key => key.startsWith('__reactFiber$'));
    let fiber = key ? (canvas as unknown as Record<string, Fiber>)[key] : undefined;
    for (let depth = 0; fiber && depth < 80; depth++, fiber = fiber.return) {
      if (fiber.memoizedProps?.conn !== session.conn || fiber.memoizedProps.myIdentity !== session.identity) continue;
      const map = fiber.memoizedProps.ref?.current ?? fiber.ref?.current;
      if (typeof map?.quoteSend === 'function' && typeof map.listOwnedBodies === 'function' && session.conn.db.swarm) return { ...session, map };
    }
  }
  throw new Error('游戏报价或舰队接口不可用，自动操作已停止。');
}
export function assertSession(session: Session): void {
  const now = getSession();
  if (now.conn !== session.conn || now.identity !== session.identity) throw new Error('游戏连接或身份已变化，请重新启动所需模式。');
}
