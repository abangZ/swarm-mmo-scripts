import { assertSession, getAutomationSession, ownedPlanets } from './session';
import { subscribe } from './subscriptions';
import type { ExpansionWorld, WorldSnapshot, Fleet } from '../features/expansion/world';
import { maxUpgradeBatch, captureMargin, members, targetKey, type Assignment, type ExpansionSettings, type TargetKind } from '../features/expansion/types';
import type { Subscription, AutomationSession, Quote } from './types';
import { validRoute, arriving, type Route } from '../features/expansion/cooperation';
import { inZone, type ModeConfig } from '../features/commander/types';
import { subscriptionBatches } from './subscription-batches';
import { ProductionTicks } from './economy';
import { fingerprint } from '../shared/fingerprint';

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
  private tileBatches: string[][] = [];
  private ownerBatches: string[][] = [];
  private configs: ModeConfig[] = [];
  private production = new ProductionTicks();
  private quoteCore?: string;
  private quoteEpoch = 0;
  private timings = { readTotalMs: 0, readCalls: 0, ownedBodiesMs: 0, quoteMaxMs: 0, slowQuotes: 0, syncCalls: 0, syncQueries: 0, syncTotalMs: 0, syncActive: 0, readMs: 0, scanMs: 0, syncMs: 0, quoteMs: 0, quoteCalls: 0, newSubscriptions: 0, reusedSubscriptions: 0 };
  diagnostics() { return { ...this.timings }; }
  configure(configs: ModeConfig[]) { this.configs = configs; }
  needsScan() {
    assertSession(this.session);
    return ownedPlanets(this.session).some(p => !this.scannedSources.has(p.planetId) && (!this.configs.length || this.configs.some(c => inZone(p, c.policy.zone))));
  }
  async scan(settings: ExpansionSettings, alive: () => boolean): Promise<void> {
    assertSession(this.session);
    const started = performance.now();
    this.timings.newSubscriptions = 0; this.timings.reusedSubscriptions = 0;
    const identity = this.session.identity;
    if (!/^[0-9a-f]{64}$/i.test(identity)) throw new Error('游戏身份格式发生变化。');
    const fresh = new Map<string, Subscription>();
    const created: Subscription[] = [];
    const add = async (query: string) => {
      const existing = this.subscriptions.get(query);
      if (existing) {
        if (!existing.isActive()) throw new Error('星球订阅已失效，请重新启动。');
        if (!alive()) throw new Error('扫描已停止。');
        this.timings.reusedSubscriptions++; fresh.set(query, existing); return;
      }
      this.timings.newSubscriptions++;
      const handle = await subscribe(this.session.conn, query);
      fresh.set(query, handle); created.push(handle);
      if (!alive()) throw new Error('扫描已停止。');
    };
    try {
      if (settings.captureMeteorites && !this.session.conn.db.meteorite2) throw new Error('陨石情报接口不可用。');
      if (settings.captureSuns && !this.session.conn.db.sun_swarm2) throw new Error('恒星舰队情报接口不可用。');
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
      const tileBatches = subscriptionBatches(this.tileBatches, tiles.keys());
      const queries: string[] = [];
      for (const batch of tileBatches) {
        const where = batch.map(key => tiles.get(key)!).join(' OR ');
        for (const table of ['planet', 'sun2', 'base']) queries.push(`SELECT * FROM ${table} WHERE ${where}`);
        if (settings.captureMeteorites) queries.push(`SELECT * FROM meteorite2 WHERE ${where}`);
        if (settings.captureSuns) queries.push(`SELECT * FROM sun_swarm2 WHERE ${where.replaceAll('position_x', 'target_x').replaceAll('position_y', 'target_y')}`);
        queries.push(`SELECT * FROM swarm WHERE ${where.replaceAll('position_x', 'target_x').replaceAll('position_y', 'target_y')}`);
      }
      for (let i = 0; i < queries.length; i += 3) {
        const batch = await Promise.allSettled(queries.slice(i, i + 3).map(add));
        const error = batch.find(r => r.status === 'rejected');
        if (error?.status === 'rejected') throw error.reason;
      }
      const owners = [...new Set([...this.session.conn.db.planet.iter()].filter(p => !this.configs.length || this.configs.some(c => inZone(p, c.policy.zone))).flatMap(p => p.ownerId ? [p.ownerId.toHexString()] : []))].sort();
      const ownerBatches = subscriptionBatches(this.ownerBatches, owners);
      for (const batch of ownerBatches) {
        if (batch.some(owner => !/^[0-9a-f]{64}$/i.test(owner))) throw new Error('玩家身份格式发生变化。');
        await add(`SELECT * FROM player WHERE ${batch.map(owner => `identity = x'${owner}'`).join(' OR ')}`);
      }
      assertSession(this.session);
      if (!alive()) throw new Error('扫描已停止。');
      for (const [query, sub] of this.subscriptions) if (!fresh.has(query)) sub.unsubscribe();
      this.subscriptions = fresh;
      this.tileBatches = tileBatches; this.ownerBatches = ownerBatches;
      this.scannedSources = new Set(owned.map(p => p.planetId));
    } catch (error) {
      for (const sub of created) sub.unsubscribe();
      throw error;
    } finally { this.timings.scanMs = performance.now() - started; }
  }
  refreshQuotes(): void {
    assertSession(this.session);
    if (!this.subscriptions.size || [...this.subscriptions.values()].some(s => !s.isActive())) throw new Error('星球订阅已失效，请重新启动。');
    const current = getAutomationSession();
    this.session.map = current.map;
    this.quotes.clear(); // A browser yield ends this synchronous quote-cache lifetime.
  }
  read(): WorldSnapshot {
    const started = performance.now();
    this.refreshQuotes();
    const allOwned = ownedPlanets(this.session);
    const owned = allOwned.filter(p => this.scannedSources.has(p.planetId) || this.configs.some(c => c.policy.zone && inZone(p, c.policy.zone)));
    const budgets = new Map<bigint, number>();
    const ownedAt = performance.now();
    const bodies = this.session.map.listOwnedBodies();
    this.timings.ownedBodiesMs = performance.now() - ownedAt;
    for (const body of bodies) {
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
      return { id: f.swarmId, owner: f.ownerId.toHexString(), target: f.targetPlanetId, source: source?.planetId, count, arrival: Number.isFinite(time) ? time : null,
        arriving: source && target && source.galaxyId === target.galaxyId ? count : null };
    });
    const fleetsByTarget = new Map<bigint, Fleet[]>();
    for (const fleet of fleets) { const group = fleetsByTarget.get(fleet.target) ?? []; group.push(fleet); fleetsByTarget.set(fleet.target, group); }
    const bodyFleets = new Map<string, Fleet[]>();
    const addBodyFleet = (id: bigint, kind: 'sun' | 'comet', row: { swarmId: bigint; ownerId: { toHexString(): string }; probeCount?: number; arrivalTime?: { toMillis(): number | bigint } }) => {
      const key = targetKey(id, kind), group = bodyFleets.get(key) ?? [];
      const time = Number(row.arrivalTime?.toMillis());
      group.push({ id: row.swarmId, owner: row.ownerId.toHexString(), target: id, count: Number.isSafeInteger(row.probeCount) ? row.probeCount! : null,
        arrival: Number.isFinite(time) ? time : null, arriving: null });
      bodyFleets.set(key, group);
    };
    for (const row of db.swarm!.iter()) {
      if (row.targetSunId && row.targetSunId > 0n) addBodyFleet(row.targetSunId, 'sun', row);
      if (row.targetMeteoriteId && row.targetMeteoriteId > 0n) addBodyFleet(row.targetMeteoriteId, 'comet', row);
    }
    for (const row of db.sun_swarm2?.iter() ?? []) if (!row.targetBlackHole && row.targetSunId > 0n) addBodyFleet(row.targetSunId, 'sun', row);
    // Quote rules depend on technology and coverage, not unrelated garrisons.
    // Source/target stock and rows are compared separately by the planner.
    const coverage = (row: unknown) => {
      const { probeCount: _probes, superprobes: _super, lastUpdateTick: _tick, ...rest } = row as Record<string, unknown>;
      return { ...rest, activeBase: typeof _super === 'number' ? _super > 0 : undefined };
    };
    const tech = [...db.player_tech.iter()];
    const assault = tech.find(row => row.playerId.toHexString() === this.session.identity)?.assault;
    // Native Hx(assault) = 1 + 0.01 * assault. Assuming coverage is optimistic;
    // missing/unknown technology disables this cheap rejection entirely.
    const attackMultiplierUpperBound = Number.isSafeInteger(assault) && assault! >= 0 ? 1 + 0.01 * assault! : undefined;
    // SDK row replacement can reorder iterators without changing any quote rule.
    // Such changes must not discard a long-running draft or its quote cache.
    const unordered = (rows: Iterable<unknown>) => [...rows].map(fingerprint).sort();
    const quoteVersion = fingerprint([this.session.identity, unordered(tech.filter(row => row.playerId.toHexString() === this.session.identity)), unordered(clans),
      unordered([...db.base.iter()].map(coverage)), unordered([...db.sun2.iter()].map(coverage)), unordered(db.galaxy?.iter() ?? [])]);
    const productionTicks = this.production.read(db, owned, allies, this.session.identity, quoteVersion);
    // Native Ft/vx/wx/bx/Cx read source-owner technology and source influence.
    // Neutral target stock/geometry are tracked per quote; galaxy geometry is
    // conservatively global. Unrelated clans and distant coverage do not affect it.
    const core = fingerprint([this.session.identity, unordered(tech.filter(row => row.playerId.toHexString() === this.session.identity)), unordered(db.galaxy?.iter() ?? [])]);
    if (core !== this.quoteCore) { this.quoteCore = core; this.quoteEpoch++; }
    const quoteGlobalVersion = `${this.session.identity}:${this.quoteEpoch}`;
    const sourceQuoteVersions = new Map(owned.map(p => [p.planetId, fingerprint([
      quoteGlobalVersion, p.ownerId, p.positionX, p.positionY, p.galaxyId, p.level, this.production.covered(p.planetId),
    ])]));
    this.timings.readMs = performance.now() - started;
    this.timings.readCalls++; this.timings.readTotalMs += this.timings.readMs;
    return { productionTicks, quoteVersion, quoteGlobalVersion, sourceQuoteVersions, attackMultiplierUpperBound, planets, owned, allOwned, budgets, incoming, fleets, fleetsByTarget, identity: this.session.identity, allies, intelligence: true,
      suns: [...db.sun2.iter()], meteorites: [...(db.meteorite2?.iter() ?? [])], bodyFleets,
      automated: new Set([...db.attack_automation.iter()].map(a => a.sourcePlanetId).concat([...db.upgrade_automation.iter()].map(a => a.planetId))),
      players: new Map([...(db.player?.iter() ?? [])].map(p => [p.identity.toHexString(), p.username])),
    };
  }
  private nativeQuote(source: bigint, target: bigint, kind: TargetKind = 'planet'): Quote | null {
    const key = `${source}:${targetKey(target, kind)}`;
    if (!this.quotes.has(key)) {
      const started = performance.now();
      try { this.timings.quoteCalls++; this.quotes.set(key, this.session.map.quoteSend('planet', source, kind, target)); }
      finally {
        const ms = performance.now() - started;
        this.timings.quoteMs += ms; this.timings.quoteMaxMs = Math.max(this.timings.quoteMaxMs, ms);
        if (ms >= 8) this.timings.slowQuotes++;
      }
    }
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
  quoteBody(source: bigint, target: bigint, kind: 'sun' | 'comet') {
    const quote = this.nativeQuote(source, target, kind);
    if (kind === 'comet') return safeQuote(quote);
    // A sun fights in whole super-probes. The native exact send already includes
    // the winning super-probe, Conversion and border loss; +1 raw probe is trimmed.
    if (!quote || !validRoute(quote) || quote.outOfRange || quote.exact?.reason !== 'capture'
      || !Number.isSafeInteger(quote.exact.probes) || quote.exact.probes < 1 || quote.exact.probes > 0xffffffff) return null;
    return { count: quote.exact.probes, travelMs: quote.travelMs };
  }
  bodyQuoteIssue(source: bigint, target: bigint, kind: 'sun' | 'comet') {
    const quote = this.nativeQuote(source, target, kind);
    if (!quote) return '原生未返回报价，来源或目标情报可能不完整';
    if (!validRoute(quote)) return '原生航时或航行损耗无效';
    if (quote.outOfRange) return `原生判定无法发射：航时 ${Math.ceil(quote.travelMs / 1000)} 秒、损耗 ${quote.lossPct}%${quote.exact?.reason === 'capture' ? `、原生需 ${quote.exact.probes} 探针` : ''}`;
    if (quote.exact?.reason !== 'capture') return `原生未给出占领报价（${quote.exact?.reason ?? '无数量说明'}）`;
    return this.quoteBody(source, target, kind) ? undefined : '原生占领数量无效或超过单次发射上限';
  }
  routeBody(source: bigint, target: bigint, kind: 'sun' | 'comet'): Route | null {
    const quote = this.nativeQuote(source, target, kind);
    return validRoute(quote) ? { travelMs: quote.travelMs, lossPct: quote.lossPct } : null;
  }
  launchBody(job: Assignment): Promise<void> {
    assertSession(this.session);
    const reducers = this.session.conn.reducers;
    if (job.targetKind === 'sun' && reducers.launchSwarmAtSun) return reducers.launchSwarmAtSun({ sourcePlanetId: job.sourceId, targetSunId: job.targetId, probeCount: job.count });
    if (job.targetKind === 'comet' && reducers.launchSwarmAtMeteorite) return reducers.launchSwarmAtMeteorite({ sourcePlanetId: job.sourceId, targetMeteoriteId: job.targetId, probeCount: job.count });
    throw new Error('目标的原生派兵接口不可用，未发射。');
  }
  upgrade(planetId: bigint): Promise<void> {
    assertSession(this.session);
    if (!this.session.conn.reducers.upgradePlanet) throw new Error('原生升级接口不可用。');
    return this.session.conn.reducers.upgradePlanet({ planetId });
  }
  upgradeMany(planetIds: bigint[]): Promise<void> {
    assertSession(this.session);
    if (!planetIds.length || planetIds.length > maxUpgradeBatch || new Set(planetIds).size !== planetIds.length) throw new Error('批量升级需要 1～200 颗不同星球。');
    if (!this.session.conn.reducers.upgradePlanetsBulk) throw new Error('原生批量升级接口不可用。');
    return this.session.conn.reducers.upgradePlanetsBulk({ planetIds });
  }
  async syncInventory(sources: bigint[]): Promise<void> {
    this.timings.syncCalls++; this.timings.syncActive++;
    const started = performance.now();
    try {
      assertSession(this.session);
      const ids = [...new Set(sources)];
      // A fresh subscription acknowledgement is an inventory barrier after a confirmed launch.
      // Keep the original owned subscription; these temporary queries only refresh spent sources.
      for (let i = 0; i < ids.length; i += 24) {
        this.timings.syncQueries++;
        const handle = await subscribe(this.session.conn, `SELECT * FROM planet WHERE ${ids.slice(i, i + 24).map(id => `planet_id = ${id}`).join(' OR ')}`);
        try { assertSession(this.session); } finally { handle.unsubscribe(); }
      }
    } finally {
      this.timings.syncMs = performance.now() - started;
      this.timings.syncTotalMs += this.timings.syncMs; this.timings.syncActive--;
    }
  }
  launch(source: bigint, target: bigint, count: number) {
    assertSession(this.session);
    return this.session.conn.reducers.launchSwarm({ sourcePlanetId: source, targetPlanetId: target, probeCount: count });
  }
  dispose() { for (const sub of this.subscriptions.values()) { try { sub.unsubscribe(); } catch { /* A disconnected subscription is already unusable. */ } } this.subscriptions.clear(); this.quotes.clear(); this.tileBatches = []; this.ownerBatches = []; }
}
