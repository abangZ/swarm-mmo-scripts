import { assertSession, getAutomationSession, ownedPlanets } from './session';
import { subscribe } from './subscriptions';
import type { ExpansionWorld, WorldSnapshot } from '../features/expansion/world';
import { members, type Assignment, type ExpansionSettings } from '../features/expansion/types';
import type { Subscription, AutomationSession } from './types';
import { validRoute, type Route } from '../features/expansion/cooperation';

export function safeQuote(quote: ReturnType<AutomationSession['map']['quoteSend']>): { count: number; travelMs: number } | null {
  if (!quote || quote.outOfRange || quote.exact?.reason !== 'capture') return null;
  const count = quote.exact.probes + 2;
  if (!Number.isSafeInteger(quote.exact.probes) || quote.exact.probes < 1 || count > 0xffffffff || !Number.isFinite(quote.travelMs) || quote.travelMs < 0) return null;
  return { count, travelMs: quote.travelMs };
}
export class GameWorld implements ExpansionWorld {
  private session = getAutomationSession();
  private subscriptions: Subscription[] = [];
  private scannedSources = new Set<bigint>();
  async scan(settings: ExpansionSettings, alive: () => boolean): Promise<void> {
    assertSession(this.session);
    const identity = this.session.identity;
    if (!/^[0-9a-f]{64}$/i.test(identity)) throw new Error('游戏身份格式发生变化。');
    const fresh: Subscription[] = [];
    const add = async (query: string) => {
      const handle = await subscribe(this.session.conn, query);
      fresh.push(handle);
      if (!alive()) throw new Error('扫描已停止。');
    };
    try {
      await add(`SELECT * FROM planet WHERE owner_key = x'${identity}'`);
      await add(`SELECT * FROM swarm WHERE owner_id = x'${identity}'`);
      const owned = ownedPlanets(this.session);
      const tiles = new Map<string, string>();
      for (const p of owned) {
        for (let x = Math.floor((p.positionX - settings.radius) / 32); x <= Math.floor((p.positionX + settings.radius) / 32); x++) {
          for (let y = Math.floor((p.positionY - settings.radius) / 32); y <= Math.floor((p.positionY + settings.radius) / 32); y++) {
            tiles.set(`${x},${y}`, `(position_x >= ${x * 32} AND position_x < ${(x + 1) * 32} AND position_y >= ${y * 32} AND position_y < ${(y + 1) * 32})`);
          }
        }
      }
      if (tiles.size > 2048) throw new Error('搜索区域过大，请缩小搜索半径后重新启动。');
      const predicates = [...tiles.values()];
      const queries: string[] = [];
      for (let i = 0; i < predicates.length; i += 24) queries.push(`SELECT * FROM planet WHERE ${predicates.slice(i, i + 24).join(' OR ')}`);
      for (let i = 0; i < queries.length; i += 3) {
        const batch = await Promise.allSettled(queries.slice(i, i + 3).map(add));
        const error = batch.find(r => r.status === 'rejected');
        if (error?.status === 'rejected') throw error.reason;
      }
      assertSession(this.session);
      if (!alive()) throw new Error('扫描已停止。');
      this.dispose();
      this.subscriptions = fresh;
      this.scannedSources = new Set(owned.map(p => p.planetId));
    } catch (error) {
      for (const sub of fresh) sub.unsubscribe();
      throw error;
    }
  }
  read(): WorldSnapshot {
    assertSession(this.session);
    if (!this.subscriptions.length || this.subscriptions.some(s => !s.isActive())) throw new Error('星球订阅已失效，请重新启动。');
    const current = getAutomationSession();
    this.session.map = current.map;
    const allOwned = ownedPlanets(this.session);
    const owned = allOwned.filter(p => this.scannedSources.has(p.planetId));
    const budgets = new Map<bigint, number>();
    for (const body of this.session.map.listOwnedBodies()) {
      if (body.kind === 'planet' && Number.isSafeInteger(body.probes) && body.probes >= 0) budgets.set(body.id, Math.min(body.probes, 0xffffffff));
    }
    const incoming = new Set<bigint>();
    for (const swarm of this.session.conn.db.swarm!.iter()) {
      if (swarm.ownerId.toHexString() === this.session.identity && swarm.targetPlanetId > 0n) incoming.add(swarm.targetPlanetId);
    }
    return { planets: [...this.session.conn.db.planet.iter()], owned, allOwned, budgets, incoming };
  }
  quote(source: bigint, target: bigint) { return safeQuote(this.session.map.quoteSend('planet', source, 'planet', target)); }
  route(source: bigint, target: bigint): Route | null {
    if (!this.session.conn.reducers.launchSwarmBulk) return null;
    const quote = this.session.map.quoteSend('planet', source, 'planet', target);
    // outOfRange also means insufficient stock for a single launch. Group capacity is checked separately.
    return validRoute(quote) ? { travelMs: quote.travelMs, lossPct: quote.lossPct } : null;
  }
  launchGroup(job: Assignment) {
    assertSession(this.session);
    const reducer = this.session.conn.reducers.launchSwarmBulk;
    if (!reducer) throw new Error('游戏批量发射接口不可用，未执行联合占领。');
    return this.session.conn.reducers.launchSwarmBulk!({ kind: 0, targetId: job.targetId, launches: members(job).map(m => ({ sourceId: m.sourceId, probeCount: m.count })) });
  }
  launch(source: bigint, target: bigint, count: number) {
    assertSession(this.session);
    return this.session.conn.reducers.launchSwarm({ sourcePlanetId: source, targetPlanetId: target, probeCount: count });
  }
  dispose() { for (const sub of this.subscriptions) { try { sub.unsubscribe(); } catch { /* A disconnected subscription is already unusable. */ } } this.subscriptions = []; }
}
