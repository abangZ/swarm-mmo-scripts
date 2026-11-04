import type { Planet, Sun } from '../../game/types';
import { fingerprint } from '../../shared/fingerprint';
import { PlanetIndex } from '../../shared/planet-index';
import { bestCandidates } from '../../shared/best-candidates';
import { distance } from '../../shared/distance';
import { globalQuoteRules } from './quote-rules';
import { hostile } from '../commander/safety';
import { inZone, type ModeConfig } from '../commander/types';
import { arriving, validRoute, type Route } from './cooperation';
import { riskEvaluator } from './strategy';
import { bodyFleetsFor, fleetsFor, type ExpansionWorld, type WorldSnapshot } from './world';
import { members, targetKey, type Assignment, type Contribution } from './types';

export const logisticsBatchSize = 50;
export const logisticsQuoteBudget = 128;
export type LogisticsKind = 'planet' | 'sun';
export interface LogisticsState {
  kind: LogisticsKind; hub: bigint; target: bigint; required: number; available: number; incoming: number;
  donors: number; checked: number; total: number; readyMs: number; upgradeMs?: number; phase: string;
}
export interface LogisticsPlan {
  job?: Assignment; reservations: Map<bigint, number>; waiting?: string; hub?: bigint; sun?: bigint; state?: LogisticsState;
}
interface Delivery { source: bigint; sent: number; count: number; at: number; expires: number }
interface Campaign {
  hub: bigint; target: bigint; since: number; deliveries: Delivery[]; attempted: Map<bigint, string>; upgraded?: number;
}
interface CachedRoute { key: string; value: Route | null; expires: number }
interface Event { count: number; at: number }
/** Forecast only. Neither future production nor incoming fleets become spendable inventory. */
export function readyAfter(stock: number, level: number, tickMs: number, required: number, events: Event[]): number {
  if (stock >= required) return 0;
  if (level <= 0 || !Number.isFinite(tickMs) || tickMs <= 0) return Infinity;
  let supplied = 0;
  for (const event of [...events].sort((a, b) => a.at - b.at)) {
    const ready = Math.ceil(Math.max(0, required - stock - supplied) / level) * tickMs;
    if (ready <= event.at) return ready;
    supplied += event.count;
    if (stock + supplied + Math.floor(event.at / tickMs) * level >= required) return event.at;
  }
  return Math.ceil(Math.max(0, required - stock - supplied) / level) * tickMs;
}

/** Persistent neutral-target campaign. Route prices depend on geometry/rules, not stock. */
export class LogisticsPlanner {
  private campaign?: Campaign;
  private routes = new Map<string, CachedRoute>();
  private routeLimit = 16000;
  private version?: string;
  private sourceVersions?: Map<bigint, string>;
  private cursor = 0;
  private topology = '';
  private pairs: { hub: bigint; target: bigint }[] = [];
  private nextDiscovery = 0;
  private state?: LogisticsState;
  private upgradeSignature?: string;
  private upgradeInputs(snapshot: WorldSnapshot) { return fingerprint([snapshot.quoteVersion, [...snapshot.budgets], snapshot.planets, snapshot.fleets, [...snapshot.automated ?? []], [...snapshot.productionTicks ?? []]]); }
  stats = { routes: 0, reused: 0 };
  constructor(readonly kind: LogisticsKind) {}
  get gathering() { return !!this.campaign; }
  get target() { return this.campaign?.target; }
  get hub() { return this.campaign?.hub; }
  reset() { this.campaign = undefined; this.routes.clear(); this.pairs = []; this.topology = ''; this.nextDiscovery = 0; }
  fork() {
    const copy = new LogisticsPlanner(this.kind);
    copy.campaign = this.campaign && { ...this.campaign, deliveries: this.campaign.deliveries.map(d => ({ ...d })), attempted: new Map(this.campaign.attempted) };
    // Pure geometry memoization may survive a cancelled draft; keys include rule and ownership fingerprints.
    copy.routes = this.routes; copy.routeLimit = this.routeLimit; copy.version = this.version; copy.sourceVersions = this.sourceVersions; copy.cursor = this.cursor; copy.topology = this.topology;
    copy.pairs = this.pairs; copy.nextDiscovery = this.nextDiscovery; copy.state = this.state; copy.upgradeSignature = this.upgradeSignature;
    return copy;
  }
  private stamp(source: Planet, stock: number) { return fingerprint([source.planetId, source.level, source.ownerId, stock]); }
  private route(world: ExpansionWorld, source: Planet, target: Planet | Sun, kind: LogisticsKind, id: bigint): Route | null {
    const key = `${source.planetId}:${kind}:${id}`;
    const geometry = fingerprint([this.sourceVersions?.get(source.planetId) ?? this.version, source.positionX, source.positionY, source.galaxyId, source.ownerId,
      target.positionX, target.positionY, target.galaxyId, target.ownerId]);
    const cached = this.routes.get(key);
    if (cached?.key === geometry && cached.expires > Date.now()) { this.stats.reused++; return cached.value; }
    if (this.stats.routes >= logisticsQuoteBudget) return null;
    this.stats.routes++;
    const value = kind === 'planet' ? world.route?.(source.planetId, id) : world.routeBody?.(source.planetId, id, 'sun');
    const result = validRoute(value) ? value : null;
    this.routes.set(key, { key: geometry, value: result, expires: Date.now() + (result ? 600000 : 10000) });
    if (this.routes.size > this.routeLimit) this.routes.delete(this.routes.keys().next().value!);
    return result;
  }
  private validHub(hub: Planet, snapshot: WorldSnapshot, config: ModeConfig) {
    return !!snapshot.intelligence && inZone(hub, config.policy.zone) && !snapshot.automated?.has(hub.planetId)
      && (this.kind !== 'sun' || !snapshot.planets.some(p => hostile(p, snapshot) && distance(p, hub) <= config.policy.threatRadius))
      && !fleetsFor(snapshot, hub.planetId).some(f => f.owner !== snapshot.identity && !snapshot.allies?.has(f.owner));
  }
  private validTarget(target: Planet | Sun, id: bigint, snapshot: WorldSnapshot, config: ModeConfig) {
    return target.ownerId == null && inZone(target, config.policy.zone) && !bodyFleetsFor(snapshot, id, this.kind).length
      && (this.kind !== 'planet' || !snapshot.incoming.has(id))
      && (!config.settings.cautiousExpansion || riskEvaluator(snapshot, config)(target) !== 'exposed');
  }
  private required(target: Planet | Sun, route: Route) {
    // Conservative funding estimate. Actual conquest always requires a native capture quote.
    return Math.ceil((target.probeCount + (this.kind === 'sun' ? 1 : 2)) * (this.kind === 'sun' ? 100 : 1) * 100 / (100 - route.lossPct));
  }
  private quote(world: ExpansionWorld, snapshot: WorldSnapshot, hub: Planet, target: Planet | Sun, config: ModeConfig): Assignment | undefined {
    const id = 'sunId' in target ? target.sunId : target.planetId;
    const quote = this.kind === 'sun' ? world.quoteBody?.(hub.planetId, id, 'sun') : world.quote(hub.planetId, id);
    if (!quote || quote.travelMs > config.settings.maxTravelMs) return;
    return { ...quote, sourceId: hub.planetId, targetId: id, targetKind: this.kind, campaignKind: this.kind,
      campaignTargetId: id, garrison: target.probeCount, reason: '募集已到账，按原生报价完成前线目标' };
  }
  *steps(world: ExpansionWorld, snapshot: WorldSnapshot, config: ModeConfig, budgets: Map<bigint, number>, locked: Set<string>, guardPercent: (hub: Planet) => number | { percent: number; deficit: number } = () => 0): Generator<void, LogisticsPlan> {
    const empty = (): LogisticsPlan => ({ reservations: new Map() });
    this.stats = { routes: 0, reused: 0 };
    const version = globalQuoteRules(snapshot);
    if (version === undefined || version !== this.version) this.routes.clear();
    this.version = version; this.sourceVersions = snapshot.sourceQuoteVersions;
    if (!snapshot.intelligence || this.kind === 'planet' && !world.route || this.kind === 'sun' && (!config.settings.captureSuns || !world.quoteBody || !world.launchBody)) { this.campaign = undefined; return empty(); }
    const sources = snapshot.owned.filter(p => inZone(p, config.policy.zone) && !snapshot.automated?.has(p.planetId));
    // Keep at least a complete donor sweep as the empire grows; otherwise a
    // cold sweep larger than the cache would evict its own prefix forever.
    this.routeLimit = Math.max(16000, sources.length * 2 + 64);
    const owned = new Map(sources.map(p => [p.planetId, p]));
    const targets = (this.kind === 'sun' ? snapshot.suns ?? [] : snapshot.planets).filter(p => p.ownerId == null && inZone(p, config.policy.zone));
    const ids = new Map(targets.map(p => ['sunId' in p ? p.sunId : p.planetId, p]));
    if (this.campaign) {
      const hub = owned.get(this.campaign.hub), target = ids.get(this.campaign.target);
      if (!hub || !target || !this.validHub(hub, snapshot, config) || !this.validTarget(target, this.campaign.target, snapshot, config)
        || distance(hub, target) > config.settings.radius || locked.has(targetKey(this.campaign.target, this.kind))) this.campaign = undefined;
    }
    if (!this.campaign) {
      const topology = fingerprint([sources.map(p => [p.planetId, p.positionX, p.positionY]), targets.map(p => ['sunId' in p ? p.sunId : p.planetId, p.positionX, p.positionY])]);
      if (topology !== this.topology) {
        this.topology = topology; this.cursor = 0; this.nextDiscovery = 0;
        const indexed = targets.map(p => ({ ...p, planetId: 'sunId' in p ? p.sunId : p.planetId }));
        const index = new PlanetIndex(indexed), pairs: { hub: bigint; target: bigint; distance: number }[] = [];
        for (const hub of sources) {
          yield;
          for (const target of bestCandidates(index.near(hub, config.settings.radius), 2, t => distance(hub, t))) pairs.push({ hub: hub.planetId, target: target.planetId, distance: distance(hub, target) });
        }
        this.pairs = pairs.sort((a, b) => a.distance - b.distance || (ids.get(a.target)?.probeCount ?? 0) - (ids.get(b.target)?.probeCount ?? 0));
      }
      if (Date.now() < this.nextDiscovery) return empty();
      for (let checked = 0; checked < 16 && this.pairs.length; checked++) {
        yield;
        const pair = this.pairs[this.cursor++];
        if (this.cursor >= this.pairs.length) { this.cursor = 0; this.nextDiscovery = Date.now() + 10000; }
        if (!pair) break;
        const hub = owned.get(pair.hub)!, target = ids.get(pair.target)!;
        if (!this.validHub(hub, snapshot, config) || !this.validTarget(target, pair.target, snapshot, config) || locked.has(targetKey(pair.target, this.kind))) continue;
        const route = this.route(world, hub, target, this.kind, pair.target);
        if (!route || route.travelMs > config.settings.maxTravelMs) continue;
        const job = this.quote(world, snapshot, hub, target, config);
        if (job && job.count <= (budgets.get(hub.planetId) ?? 0)) {
          if (this.kind === 'planet') continue; // Ordinary nearby captures stay in their existing planner.
          this.campaign = { hub: hub.planetId, target: pair.target, since: Date.now(), deliveries: [], attempted: new Map() };
          return { job, reservations: new Map([[hub.planetId, job.count]]), hub: hub.planetId, sun: pair.target };
        }
        if ((!world.launchGroup || world.supportsGroup?.() === false) && !(this.kind === 'planet' && config.settings.upgradeStable && (world.upgrade || world.upgradeMany))) continue;
        this.campaign = { hub: hub.planetId, target: pair.target, since: Date.now(), deliveries: [], attempted: new Map() };
        break;
      }
    }
    const campaign = this.campaign;
    if (!campaign) return empty();
    const hub = owned.get(campaign.hub)!, target = ids.get(campaign.target)!;
    const route = this.route(world, hub, target, this.kind, campaign.target);
    if (!route || route.travelMs > config.settings.maxTravelMs) { this.campaign = undefined; return empty(); }
    const stock = budgets.get(hub.planetId) ?? 0;
    const ready = this.quote(world, snapshot, hub, target, config);
    const required = ready?.count ?? this.required(target, route);
    if (!Number.isSafeInteger(required) || required > 0xffffffff) { this.campaign = undefined; return empty(); }
    if (ready && ready.count <= stock) return { job: ready, reservations: new Map([[hub.planetId, ready.count]]), hub: hub.planetId, sun: this.kind === 'sun' ? campaign.target : undefined };
    if (this.kind === 'planet') {
      // A persistent expensive goal must not monopolize the hub when a newly
      // visible cheap capture can advance the frontier right now.
      const nearby = snapshot.planets.filter(p => p.planetId !== campaign.target && p.ownerId == null && p.probeCount < Math.ceil(stock * (snapshot.attackMultiplierUpperBound ?? Infinity))
        && inZone(p, config.policy.zone) && distance(p, hub) <= config.settings.radius && !locked.has(targetKey(p.planetId)));
      for (const candidate of bestCandidates(nearby, 4, p => distance(p, hub))) {
        yield;
        if (!this.validTarget(candidate, candidate.planetId, snapshot, config)) continue;
        const capture = this.quote(world, snapshot, hub, candidate, config);
        if (capture && capture.count <= stock) return { job: { ...capture, campaignTargetId: campaign.target, reason: '等待大目标期间，先占领附近可打目标' },
          reservations: new Map([[hub.planetId, Math.min(stock, required)]]), hub: hub.planetId };
      }
    }
    const guard = guardPercent(hub);
    const ratio = 1 - (typeof guard === 'number' ? guard : guard.percent) / 100;
    // An under-defended hub must first restore its existing fixed reserve.
    const deficit = typeof guard === 'number' ? 0 : Math.max(0, guard.deficit);
    const fundingRequired = required + deficit;
    if (ratio <= 0) return empty();
    const incoming = fleetsFor(snapshot, hub.planetId);
    campaign.deliveries = campaign.deliveries.filter(d => d.expires > Date.now());
    const unmatched = new Set(campaign.deliveries), events: Event[] = [];
    let unknown = false;
    for (const fleet of incoming) {
      const match = [...unmatched].find(d => fleet.source === d.source && fleet.count === d.sent && fleet.arrival !== null && Math.abs(fleet.arrival - d.at) <= 5000);
      if (match) unmatched.delete(match);
      const count = fleet.arriving ?? match?.count;
      if (count === undefined || count === null || fleet.arrival === null) { unknown = true; break; }
      events.push({ count: count * ratio, at: Math.max(0, fleet.arrival - Date.now()) });
    }
    if (unknown) return { reservations: new Map([[hub.planetId, Math.min(stock, required)]]), waiting: `中转星 #${hub.planetId} 来援数量或损耗未知，等待内存情报更新` };
    // Exact source/count/arrival matches deduplicate our own cross-galaxy fleets;
    // unmatched external arrivals are additional supply, not zero or duplicates.
    for (const delivery of unmatched) events.push({ count: delivery.count * ratio, at: Math.max(0, delivery.at - Date.now()) });
    const received = events.reduce((n, event) => n + event.count, 0);
    const tickMs = snapshot.productionTicks?.get(hub.planetId) ?? 60000;
    const level = hub.level ?? 1;
    const candidates = world.launchGroup && world.supportsGroup?.() !== false ? sources.filter(p => p.planetId !== hub.planetId && (budgets.get(p.planetId) ?? 0) > 0) : [];
    candidates.sort((a, b) => distance(a, hub) - distance(b, hub) || (budgets.get(b.planetId) ?? 0) - (budgets.get(a.planetId) ?? 0));
    const donors: { source: Planet; available: number; route: Route }[] = [];
    let checked = 0, possible = received;
    for (const source of candidates) {
      yield;
      const stamp = this.stamp(source, snapshot.budgets.get(source.planetId) ?? 0);
      if (campaign.attempted.get(source.planetId) === stamp) { checked++; continue; }
      const donorRoute = this.route(world, source, hub, 'planet', hub.planetId);
      if (!donorRoute && this.stats.routes >= logisticsQuoteBudget) break;
      checked++;
      if (!donorRoute || donorRoute.travelMs > config.settings.maxTravelMs) continue;
      const available = budgets.get(source.planetId)!;
      donors.push({ source, available, route: donorRoute }); possible += arriving(available, donorRoute.lossPct) * ratio;
      // Once enough stock can arrive soon, upgrading cannot beat that supply.
      if (possible + stock >= fundingRequired + 100) break;
    }
    donors.sort((a, b) => a.route.travelMs - b.route.travelMs || b.available - a.available);
    const allocations: Contribution[] = [], supplyEvents = [...events];
    let gap = Math.max(0, fundingRequired - stock - received);
    for (const donor of donors) {
      if (gap <= 0) break;
      const count = Math.min(donor.available, Math.ceil(gap / ratio * 100 / (100 - donor.route.lossPct)));
      const delivered = arriving(count, donor.route.lossPct) * ratio;
      if (delivered <= 0) continue;
      const at = donor.route.travelMs + Math.floor(allocations.length / logisticsBatchSize) * config.settings.intervalMs;
      allocations.push({ sourceId: donor.source.planetId, count, travelMs: donor.route.travelMs, lossPct: donor.route.lossPct });
      supplyEvents.push({ count: delivered, at }); gap -= delivered;
    }
    const optimisticRequired = ready?.count ?? (this.kind === 'planet'
      ? Math.max(1, Math.floor(target.probeCount / (snapshot.attackMultiplierUpperBound ?? 2) * 100 / (100 - route.lossPct))) : required);
    // Upgrade must beat the fastest plausible no-upgrade outcome, even when
    // the native capture price is unavailable at the hub's current stock.
    const wait = readyAfter(stock + level, level, tickMs, optimisticRequired + deficit, supplyEvents);
    const cost = 100; // 1 -> 2, undiscounted bound. Never spend predicted production.
    const upgradeDelay = config.settings.intervalMs;
    const upgradedWait = level === 1 && stock >= cost ? upgradeDelay + readyAfter(stock - cost, 2, tickMs, fundingRequired,
      supplyEvents.map(event => ({ ...event, at: Math.max(0, event.at - upgradeDelay) }))) : Infinity;
    const safeUpgrade = !!(world.upgrade || world.upgradeMany) && this.kind === 'planet' && config.settings.upgradeStable && campaign.upgraded !== level && level === 1
      && Date.now() - campaign.since >= config.settings.stableMs && !incoming.length && !campaign.deliveries.length
      && !snapshot.planets.some(p => hostile(p, snapshot) && distance(p, hub) <= config.policy.threatRadius)
      && !snapshot.planets.some(p => p.ownerId == null && distance(p, hub) <= config.settings.radius && p.probeCount + 2 <= stock)
      && checked === candidates.length && upgradedWait + 1000 < wait && cost * tickMs <= config.settings.economicHorizonMs;
    const state: LogisticsState = { kind: this.kind, hub: hub.planetId, target: campaign.target, required, available: stock, incoming: Math.round(received),
      donors: allocations.length, checked, total: candidates.length, readyMs: wait + route.travelMs, upgradeMs: Number.isFinite(upgradedWait) ? upgradedWait + route.travelMs : undefined,
      phase: checked < candidates.length && gap > 0 ? '增量检查后方航路' : gap > 0 ? '等待兵力增长' : allocations.length ? '分批募集补给' : '等待补给到账' };
    this.state = state;
    this.upgradeSignature = safeUpgrade ? this.upgradeInputs(snapshot) : undefined;
    const reservations = new Map<bigint, number>(this.kind === 'sun' && gap > 0 && checked === candidates.length ? [] : [[hub.planetId, Math.min(stock, required)]]);
    let job: Assignment | undefined;
    if (safeUpgrade) job = { sourceId: hub.planetId, targetId: hub.planetId, count: cost, travelMs: 0, expectedLevel: 1, kind: 'upgrade',
      campaignKind: this.kind, campaignTargetId: campaign.target, garrison: target.probeCount,
      reason: `前线升级后预计 ${Math.ceil(state.upgradeMs! / 60000)} 分钟占领，直接攒兵/补给约 ${Math.ceil(state.readyMs / 60000)} 分钟` };
    else if (gap <= 0 && allocations.length) {
      const [lead, ...support] = allocations.slice(0, logisticsBatchSize);
      job = { ...lead, support, targetId: hub.planetId, kind: this.kind === 'sun' ? 'sun-supply' : 'expansion-supply',
        campaignKind: this.kind, campaignTargetId: campaign.target, sunId: this.kind === 'sun' ? campaign.target : undefined,
        hubBudget: Math.min(stock, required), garrison: target.probeCount, reason: `${state.phase}：${allocations.length} 颗来源，实际到账后出击` };
      for (const m of members(job)) reservations.set(m.sourceId, m.count);
    }
    return { job, reservations, hub: hub.planetId, sun: this.kind === 'sun' ? campaign.target : undefined, state,
      waiting: `${this.kind === 'sun' ? '恒星' : '前线'} #${campaign.target}：${state.phase}；中转 #${hub.planetId} 可用 ${stock}/${required}，在途 ${state.incoming}` };
  }
  validSupply(job: Assignment, snapshot: WorldSnapshot, config: ModeConfig): boolean {
    const hub = snapshot.owned.find(p => p.planetId === job.targetId), targetId = job.campaignTargetId ?? job.sunId;
    const target = targetId === undefined ? undefined : this.kind === 'sun' ? snapshot.suns?.find(p => p.sunId === targetId) : snapshot.planets.find(p => p.planetId === targetId);
    return !!hub && !!target && (!job.campaignKind || !!this.campaign && this.campaign.hub === hub.planetId && this.campaign.target === targetId)
      && this.validHub(hub, snapshot, config) && this.validTarget(target, targetId!, snapshot, config) && target.probeCount === job.garrison
      && distance(hub, target) <= config.settings.radius;
  }
  validUpgrade(job: Assignment, snapshot: WorldSnapshot, config: ModeConfig, available: number) {
    const hub = snapshot.owned.find(p => p.planetId === job.sourceId), target = snapshot.planets.find(p => p.planetId === job.campaignTargetId);
    if (!hub || !target || hub.level !== 1 || available < job.count || !this.campaign || this.campaign.target !== job.campaignTargetId || this.campaign.upgraded === 1
      || !this.validHub(hub, snapshot, config) || !this.validTarget(target, job.campaignTargetId!, snapshot, config) || target.probeCount !== job.garrison
      || this.upgradeSignature !== this.upgradeInputs(snapshot) || fleetsFor(snapshot, hub.planetId).length || !this.state || this.state.upgradeMs === undefined || this.state.upgradeMs + 1000 >= this.state.readyMs) return false;
    // A changed hub stock or a new threat requires a fresh ETA comparison.
    return available === this.state.available && !snapshot.planets.some(p => hostile(p, snapshot) && distance(p, hub) <= config.policy.threatRadius);
  }
  launched(job: Assignment, snapshot?: WorldSnapshot) {
    if (!this.campaign) return;
    if (job.kind === 'sun-supply' || job.kind === 'expansion-supply') {
      for (const member of members(job)) {
        this.campaign.deliveries.push({ source: member.sourceId, sent: member.count, count: arriving(member.count, member.lossPct ?? 0), at: Date.now() + member.travelMs, expires: Date.now() + member.travelMs + 30000 });
        const source = snapshot?.owned.find(p => p.planetId === member.sourceId);
        if (source) this.campaign.attempted.set(member.sourceId, this.stamp(source, snapshot!.budgets.get(member.sourceId) ?? 0));
      }
    } else if (job.kind === 'upgrade') this.campaign.upgraded = job.expectedLevel;
    else if (job.targetId === this.campaign.target && (job.targetKind ?? 'planet') === this.kind) this.campaign = undefined;
  }
}
