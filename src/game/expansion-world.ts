import { assertSession, getAutomationSession, ownedPlanets } from './session';
import { subscribe } from './subscriptions';
import type { ExpansionWorld, WorldSnapshot, Fleet } from '../features/expansion/world';
import { captureMargin, members, type Assignment, type ExpansionSettings } from '../features/expansion/types';
import type { Subscription, AutomationSession, Quote } from './types';
import { validRoute, arriving, type Route } from '../features/expansion/cooperation';
import { inZone, type ModeConfig } from '../features/commander/types';

export function safeQuote(quote: ReturnType<AutomationSession['map']['quoteSend']>): { count: number; travelMs: number } | null {
  if (!quote || quote.outOfRange || quote.exact?.reason !== 'capture') return null;
  if (!validRoute(quote)) return null;
  const count = Math.max(quote.exact.probes + captureMargin, Math.ceil((arriving(quote.exact.probes, quote.lossPct) + captureMargin) * 100 / (100 - quote.lossPct)));
  if (!Number.isSafeInteger(quote.exact.probes) || quote.exact.probes < 1 || count > 0xffffffff || !Number.isFinite(quote.travelMs) || quote.travelMs < 0) return null;
  return { count, travelMs: quote.travelMs };
}
export class GameWorld implements ExpansionWorld {
  private session = getAutomationSession();
  private subscriptions = new Map<string, Subscription>();
  private quotes = new Map<string, Quote | null>();
  private scannedSources = new Set<bigint>();
  private configs: ModeConfig[] = [];
  configure(configs: ModeConfig[]) { this.configs = configs; }
  needsScan() {
    assertSession(this.session);
    return ownedPlanets(this.session).some(p => !this.scannedSources.has(p.planetId) && (!this.configs.length || this.configs.some(c => inZone(p, c.policy.zone))));
  }
  async scan(settings: ExpansionSettings, alive: () => boolean): Promise<void> {
    assertSession(this.session);
    const identity = this.session.identity;
    if (!/^[0-9a-f]{64}$/i.test(identity)) throw new Error('游戏身份格式发生变化。');
    const fresh = new Map<string, Subscription>();
    const created: Subscription[] = [];
    const add = async (query: string) => {
      const existing = this.subscriptions.get(query);
      if (existing) {
        if (!existing.isActive()) throw new Error('星球订阅已失效，请重新启动。');
        if (!alive()) throw new Error('扫描已停止。');
        fresh.set(query, existing); return;
      }
      const handle = await subscribe(this.session.conn, query);
      fresh.set(query, handle); created.push(handle);
      if (!alive()) throw new Error('扫描已停止。');
    };
    try {
      await add(`SELECT * FROM planet WHERE owner_key = x'${identity}'`);
      await add(`SELECT * FROM swarm WHERE owner_id = x'${identity}'`);
      for (const table of ['clan_member2', 'player_tech']) await add(`SELECT * FROM ${table}`);
      for (const table of ['attack_automation', 'upgrade_automation']) await add(`SELECT * FROM ${table} WHERE owner_id = x'${identity}'`);
      const owned = ownedPlanets(this.session).filter(p => !this.configs.length || this.configs.some(c => inZone(p, c.policy.zone)));
      const tiles = new Map<string, string>();
      const areas = this.configs.length ? this.configs.flatMap(c => c.policy.zone
        ? [{ positionX: c.policy.zone.x, positionY: c.policy.zone.y, radius: c.policy.zone.radius + c.policy.threatRadius + 10 }]
        : owned.map(p => ({ ...p, radius: Math.max(c.settings.radius, c.policy.threatRadius) + 10 })))
        : owned.map(p => ({ ...p, radius: settings.radius + 10 }));
      for (const p of areas) {
        for (let x = Math.floor((p.positionX - p.radius) / 32); x <= Math.floor((p.positionX + p.radius) / 32); x++) {
          for (let y = Math.floor((p.positionY - p.radius) / 32); y <= Math.floor((p.positionY + p.radius) / 32); y++) {
            tiles.set(`${x},${y}`, `(position_x >= ${x * 32} AND position_x < ${(x + 1) * 32} AND position_y >= ${y * 32} AND position_y < ${(y + 1) * 32})`);
          }
        }
      }
      if (tiles.size > 2048) throw new Error('搜索区域过大，请缩小搜索半径后重新启动。');
      const predicates = [...tiles.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
      const queries: string[] = [];
      for (let i = 0; i < predicates.length; i += 24) {
        const where = predicates.slice(i, i + 24).join(' OR ');
        for (const table of ['planet', 'sun2', 'base']) queries.push(`SELECT * FROM ${table} WHERE ${where}`);
        queries.push(`SELECT * FROM swarm WHERE ${where.replaceAll('position_x', 'target_x').replaceAll('position_y', 'target_y')}`);
      }
      for (let i = 0; i < queries.length; i += 3) {
        const batch = await Promise.allSettled(queries.slice(i, i + 3).map(add));
        const error = batch.find(r => r.status === 'rejected');
        if (error?.status === 'rejected') throw error.reason;
      }
      const owners = [...new Set([...this.session.conn.db.planet.iter()].filter(p => !this.configs.length || this.configs.some(c => inZone(p, c.policy.zone))).flatMap(p => p.ownerId ? [p.ownerId.toHexString()] : []))].sort();
      for (let i = 0; i < owners.length; i += 24) {
        const batch = owners.slice(i, i + 24);
        if (batch.some(owner => !/^[0-9a-f]{64}$/i.test(owner))) throw new Error('玩家身份格式发生变化。');
        await add(`SELECT * FROM player WHERE ${batch.map(owner => `identity = x'${owner}'`).join(' OR ')}`);
      }
      assertSession(this.session);
      if (!alive()) throw new Error('扫描已停止。');
      for (const [query, sub] of this.subscriptions) if (!fresh.has(query)) sub.unsubscribe();
      this.subscriptions = fresh;
      this.scannedSources = new Set(owned.map(p => p.planetId));
    } catch (error) {
      for (const sub of created) sub.unsubscribe();
      throw error;
    }
  }
  read(): WorldSnapshot {
    assertSession(this.session);
    if (!this.subscriptions.size || [...this.subscriptions.values()].some(s => !s.isActive())) throw new Error('星球订阅已失效，请重新启动。');
    const current = getAutomationSession();
    this.session.map = current.map;
    this.quotes.clear(); // Reuse route/native quotes only within this synchronous planning snapshot.
    const allOwned = ownedPlanets(this.session);
    const owned = allOwned.filter(p => this.scannedSources.has(p.planetId) || this.configs.some(c => c.policy.zone && inZone(p, c.policy.zone)));
    const budgets = new Map<bigint, number>();
    for (const body of this.session.map.listOwnedBodies()) {
      if (body.kind === 'planet' && Number.isSafeInteger(body.probes) && body.probes >= 0) budgets.set(body.id, Math.min(body.probes, 0xffffffff));
    }
    const incoming = new Set<bigint>();
    for (const swarm of this.session.conn.db.swarm!.iter()) {
      if (swarm.ownerId.toHexString() === this.session.identity && swarm.targetPlanetId > 0n) incoming.add(swarm.targetPlanetId);
    }
    const db = this.session.conn.db;
    if (!db.clan_member2 || !db.player_tech || !db.sun2 || !db.base || !db.attack_automation || !db.upgrade_automation) throw new Error('战区情报接口发生变化，已停止。');
    const clans = [...db.clan_member2.iter()];
    const clan = clans.find(c => c.playerId.toHexString() === this.session.identity)?.clanId;
    const allies = new Set([this.session.identity, ...clans.filter(c => clan !== undefined && c.clanId === clan).map(c => c.playerId.toHexString())]);
    const planets = [...db.planet.iter()];
    const positions = new Map(planets.map(p => [`${p.positionX},${p.positionY}`, p]));
    const targets = new Map(planets.map(p => [p.planetId, p]));
    const fleets = [...db.swarm!.iter()].filter(f => f.targetPlanetId > 0n).map(f => {
      const count = Number.isSafeInteger(f.probeCount) && f.probeCount! >= 0 ? f.probeCount! : null;
      const time = Number(f.arrivalTime?.toMillis());
      const source = positions.get(`${f.sourceX},${f.sourceY}`), target = targets.get(f.targetPlanetId);
      return { id: f.swarmId, owner: f.ownerId.toHexString(), target: f.targetPlanetId, count, arrival: Number.isFinite(time) ? time : null,
        arriving: source && target && source.galaxyId === target.galaxyId ? count : null };
    });
    const fleetsByTarget = new Map<bigint, Fleet[]>();
    for (const fleet of fleets) { const group = fleetsByTarget.get(fleet.target) ?? []; group.push(fleet); fleetsByTarget.set(fleet.target, group); }
    return { planets, owned, allOwned, budgets, incoming, fleets, fleetsByTarget, identity: this.session.identity, allies, intelligence: true,
      automated: new Set([...db.attack_automation.iter()].map(a => a.sourcePlanetId).concat([...db.upgrade_automation.iter()].map(a => a.planetId))),
      players: new Map([...(db.player?.iter() ?? [])].map(p => [p.identity.toHexString(), p.username])),
    };
  }
  private nativeQuote(source: bigint, target: bigint): Quote | null {
    const key = `${source}:${target}`;
    if (!this.quotes.has(key)) this.quotes.set(key, this.session.map.quoteSend('planet', source, 'planet', target));
    return this.quotes.get(key)!;
  }
  quote(source: bigint, target: bigint) { return safeQuote(this.nativeQuote(source, target)); }
  route(source: bigint, target: bigint): Route | null {
    const quote = this.nativeQuote(source, target);
    // outOfRange also means insufficient stock for a single launch. Group capacity is checked separately.
    return validRoute(quote) ? { travelMs: quote.travelMs, lossPct: quote.lossPct } : null;
  }
  launchGroup(job: Assignment) {
    assertSession(this.session);
    const reducer = this.session.conn.reducers.launchSwarmBulk;
    if (!reducer) throw new Error('游戏批量发射接口不可用，未执行联合占领。');
    return this.session.conn.reducers.launchSwarmBulk!({ kind: 0, targetId: job.targetId, launches: members(job).map(m => ({ sourceId: m.sourceId, probeCount: m.count })) });
  }
  supportsGroup() { return typeof this.session.conn.reducers.launchSwarmBulk === 'function'; }
  async syncInventory(sources: bigint[]): Promise<void> {
    assertSession(this.session);
    const ids = [...new Set(sources)];
    // A fresh subscription acknowledgement is an inventory barrier after a confirmed launch.
    // Keep the original owned subscription; these temporary queries only refresh spent sources.
    for (let i = 0; i < ids.length; i += 24) {
      const handle = await subscribe(this.session.conn, `SELECT * FROM planet WHERE ${ids.slice(i, i + 24).map(id => `planet_id = ${id}`).join(' OR ')}`);
      try { assertSession(this.session); } finally { handle.unsubscribe(); }
    }
  }
  launch(source: bigint, target: bigint, count: number) {
    assertSession(this.session);
    return this.session.conn.reducers.launchSwarm({ sourcePlanetId: source, targetPlanetId: target, probeCount: count });
  }
  dispose() { for (const sub of this.subscriptions.values()) { try { sub.unsubscribe(); } catch { /* A disconnected subscription is already unusable. */ } } this.subscriptions.clear(); this.quotes.clear(); }
}
