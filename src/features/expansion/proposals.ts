import type { ExpansionWorld, WorldSnapshot } from './world';
import { fleetsFor } from './world';
import { captureMargin, members, type Assignment, type ExpansionSettings } from './types';
import { coalitionOptions, cooperationGroups, cooperationRadius, validRoute, type GroupSource } from './cooperation';
import type { Planet } from '../../game/types';
import type { ModeConfig } from '../commander/types';
import { inZone } from '../commander/types';
import { distance } from '../../shared/distance';
import { PlanetIndex } from '../../shared/planet-index';
import { bestCandidates } from '../../shared/best-candidates';
import { finishPlanning } from '../../runtime/planning';
import { riskEvaluator } from './strategy';
import type { CandidateSearch } from './candidate-search';
import { sourceQuoteRules } from './quote-rules';

/** Unknown/conflicting fleets remain locked. Only our known same-galaxy waves get deficit top-ups. */
export function neutralRemaining(target: Planet, snapshot: WorldSnapshot, travelMs: number): number | null {
  const fleets = fleetsFor(snapshot, target.planetId);
  if (!fleets.length) return snapshot.incoming.has(target.planetId) ? null : target.probeCount + 1 + captureMargin;
  if (fleets.some(f => f.owner !== snapshot.identity || f.arriving === null || f.arrival === null || f.arrival > Date.now() + travelMs)) return null;
  const remaining = target.probeCount + 1 + captureMargin - fleets.reduce((n, f) => n + f.arriving!, 0);
  return remaining > 0 ? remaining : null;
}
export function expansionQuote(world: ExpansionWorld, snapshot: WorldSnapshot, source: Planet, target: Planet, config: ModeConfig): Assignment | null {
  if (target.ownerId != null || !inZone(source, config.policy.zone) || !inZone(target, config.policy.zone) || distance(source, target) > config.settings.radius) return null;
  const route = world.route?.(source.planetId, target.planetId);
  const native = world.quote(source.planetId, target.planetId);
  const travelMs = native?.travelMs ?? route?.travelMs;
  if (travelMs === undefined || !Number.isFinite(travelMs) || travelMs < 0 || travelMs > config.settings.maxTravelMs) return null;
  const remaining = neutralRemaining(target, snapshot, travelMs);
  if (remaining === null) return null;
  const hasFleet = fleetsFor(snapshot, target.planetId).length > 0;
  const count = hasFleet && validRoute(route) ? Math.ceil(remaining * 100 / (100 - route.lossPct)) : native?.count;
  if (!count || !Number.isSafeInteger(count) || count > 0xffffffff) return null;
  return { sourceId: source.planetId, targetId: target.planetId, count, travelMs };
}
export interface SourceReport { sourceId: bigint; x: number; y: number; available: number; reason: string }
export interface ExpansionProposals { edges: Assignment[]; candidates: number; sources: SourceReport[]; readySources: number; exposed?: number; deferredSources?: number }
export function expansionProposals(world: ExpansionWorld, snapshot: WorldSnapshot, config: ModeConfig, budgets: Map<bigint, number>, locked: Set<bigint>): ExpansionProposals {
  return finishPlanning(expansionProposalSteps(world, snapshot, config, budgets, locked));
}
export function* expansionProposalSteps(world: ExpansionWorld, snapshot: WorldSnapshot, config: ModeConfig, budgets: Map<bigint, number>, locked: Set<bigint>, progress?: (completed: number, total: number) => void, search?: CandidateSearch): Generator<void, ExpansionProposals> {
  const { settings } = config;
  if (settings.peacefulDevelopment) {
    const sources: SourceReport[] = [];
    for (const p of snapshot.owned) {
      yield;
      if (!inZone(p, config.policy.zone)) continue;
      const available = budgets.get(p.planetId) ?? 0;
      sources.push({ sourceId: p.planetId, x: p.positionX, y: p.positionY, available,
        reason: available > 0 ? '安稳发育：保留余兵等待无主陨石' : '兵力已用于防守或其他任务' });
    }
    progress?.(sources.length, sources.length);
    return { edges: [], candidates: 0, sources, readySources: sources.filter(p => p.available > 0).length };
  }
  const neutrals = snapshot.planets.filter(p => p.ownerId == null && inZone(p, config.policy.zone));
  const risk = riskEvaluator(snapshot, config);
  const exposed = new Set<bigint>();
  for (const [i, target] of neutrals.entries()) { if (risk(target) === 'exposed') exposed.add(target.planetId); if (i % 32 === 0) yield; }
  const targets = neutrals.filter(p => !locked.has(p.planetId) && neutralRemaining(p, snapshot, Infinity) !== null
    && (!settings.cautiousExpansion || !exposed.has(p.planetId)));
  const allIndex = new PlanetIndex(neutrals);
  const index = new PlanetIndex(targets), frontier = new Map<bigint, number>();
  const opportunity = (p: Planet) => {
    if (!frontier.has(p.planetId)) frontier.set(p.planetId, Math.min(10, index.near(p, Math.min(settings.radius, 8)).filter(q => q.planetId !== p.planetId && q.probeCount <= p.probeCount + 10).length));
    return frontier.get(p.planetId)!;
  };
  const value = (p: Planet, travelMs: number) => (p.level ?? 1) * Math.max(0, settings.economicHorizonMs - travelMs) / 60000 + opportunity(p) * 0.1;
  const sources = snapshot.owned.filter(p => inZone(p, config.policy.zone));
  const sourceIndex = new PlanetIndex(sources);
  // These three ranks do not depend on the source. Compute them once, preserving
  // near()'s tie order, then filter by distance for each source. Only rank the union
  // of eligible neighborhoods; unrelated cached map regions need no opportunity work.
  const reachable = new Set<bigint>();
  for (const source of sources) {
    yield;
    if ((budgets.get(source.planetId) ?? 0) > 0) for (const target of index.near(source, settings.radius)) reachable.add(target.planetId);
  }
  const ranked = index.ordered().filter(p => reachable.has(p.planetId));
  for (const [i, target] of ranked.entries()) { opportunity(target); if (i % 16 === 0) yield; }
  const staticOrders: Planet[][] = [];
  for (const rank of [(p: Planet) => p.probeCount, (p: Planet) => -(p.level ?? 1) / (p.probeCount + 1 + captureMargin), (p: Planet) => -opportunity(p)]) {
    staticOrders.push(bestCandidates(ranked, ranked.length, rank));
    yield;
  }
  const squaredDistance = (a: Planet, b: Planet) => (a.positionX - b.positionX) ** 2 + (a.positionY - b.positionY) ** 2;
  const edges: Assignment[] = [], seen = new Set<bigint>();
  const reports: SourceReport[] = [];
  progress?.(0, sources.length);
  const groups = new Map<bigint, { target: Planet; sources: GroupSource[] }>();
  for (const source of sources) {
    yield;
    progress?.(reports.length, sources.length);
    const available = budgets.get(source.planetId) ?? 0;
    const report = { sourceId: source.planetId, x: source.positionX, y: source.positionY, available, reason: '单星兵力不足或报价不可用，暂时没有可行协同' };
    reports.push(report);
    if (available <= 0) { report.reason = '无可用兵力：已扣除留守、进攻预留及待同步的发射'; continue; }
    const eligible = index.near(source, settings.radius);
    if (!eligible.length) {
      report.reason = settings.cautiousExpansion && allIndex.near(source, settings.radius).some(p => exposed.has(p.planetId)) ? '稳健扩张暂缓敌方更近、缺乏近邻支援的孤立目标'
        : allIndex.near(source, settings.radius).length ? '范围内目标已在途或锁定，避免重复发射' : '搜索距离 / 战区内没有无主星';
      continue;
    }
    // An upper bound deliberately ignores travel loss, target reachability and
    // arrival spread. If even this cannot win, neither a solo nor any allowed
    // coalition containing this source can succeed. No native quote is needed.
    const peers = settings.maxSources > 1 && world.launchGroup && world.supportsGroup?.() !== false
      ? sourceIndex.near(source, cooperationRadius).filter(p => p.planetId !== source.planetId)
        .map(p => Math.max(0, budgets.get(p.planetId) ?? 0)).sort((a, b) => b - a).slice(0, settings.maxSources - 1) : [];
    const multiplier = snapshot.attackMultiplierUpperBound;
    const optimisticPower = multiplier !== undefined && Number.isFinite(multiplier) && multiplier >= 1
      ? [available, ...peers].reduce((n, count) => n + Math.ceil(count * multiplier), 0) : Infinity;
    const soloPower = multiplier !== undefined && Number.isFinite(multiplier) && multiplier >= 1 ? Math.ceil(available * multiplier) : Infinity;
    const limit = Math.max(32, settings.candidates * 8);
    // The first k entries of each stable ordering suffice to reproduce the same
    // interleaved pool of k unique targets, including ties and candidate backfill.
    const nearest = bestCandidates(eligible, limit, p => squaredDistance(source, p));
    const orders = [
      nearest,
      ...staticOrders.map(order => {
        const picked: Planet[] = [];
        for (const p of order) if (squaredDistance(source, p) <= settings.radius ** 2) { picked.push(p); if (picked.length >= limit) break; }
        return picked;
      }),
    ];
    // Backfill n with feasible opportunities, rather than letting nearby unaffordable
    // or overly slow targets use all candidate slots. Bound native quote work per source.
    const pool = new Map<bigint, Planet>();
    for (let i = 0; pool.size < limit && i < eligible.length; i++) for (const order of orders) {
      if (order[i] && pool.size < limit) pool.set(order[i].planetId, order[i]);
    }
    // Finish the near-distance prefix before considering economical/frontier
    // fallbacks. Sorting an interleaved sample afterwards cannot recover nearby
    // targets that were never quoted. Retain the old mixed pool for backfilling.
    const ordered = new Map([...nearest, ...pool.values()].map(p => [p.planetId, p]));
    const continuation = search?.source(source, available, [...ordered.values()], settings.candidates, sourceQuoteRules(snapshot, source.planetId));
    const evaluated: { target: Planet; quote: Assignment | null; route: ReturnType<NonNullable<ExpansionWorld['route']>> | undefined }[] = [];
    let affordable = 0;
    let impossible = 0;
    let coalitionRoutes = 0;
    for (const { target, offset } of continuation?.visits ?? [...ordered.values()].map(target => ({ target, offset: -1 }))) {
      // Check the time slice before each native in-memory quote. A slow quote
      // must not force another batch of calls before timers can dispatch.
      yield;
      const hasFleet = fleetsFor(snapshot, target.planetId).length > 0;
      if (!hasFleet && optimisticPower <= target.probeCount) { impossible++; continue; }
      const coalitionOnly = !hasFleet && soloPower <= target.probeCount;
      // The old stop condition counted only affordable SOLO quotes. A source
      // needing cooperation consequently priced 8n+ targets but retained n.
      // Fill its nearby coalition quota, then keep looking cheaply for solos.
      // Existing-fleet deficit top-ups always retain their native quote path.
      if (coalitionOnly && coalitionRoutes >= settings.candidates) continue;
      if (continuation && !continuation.allow(target.planetId, offset)) continue;
      const quote = coalitionOnly ? null : expansionQuote(world, snapshot, source, target, config);
      const route = world.route?.(source.planetId, target.planetId);
      evaluated.push({ target, quote, route });
      if (validRoute(route) && route.travelMs <= settings.maxTravelMs && !hasFleet && !snapshot.incoming.has(target.planetId)) coalitionRoutes++;
      if (quote && quote.count <= available) affordable++;
      if (affordable >= settings.candidates && (!continuation || continuation.settled)) break;
    }
    for (const { target } of evaluated) seen.add(target.planetId);
    const solos = evaluated.filter(e => e.quote && e.quote.count <= available).sort((a, b) => a.quote!.travelMs - b.quote!.travelMs || a.quote!.count - b.quote!.count);
    const groupCandidates = settings.maxSources > 1 && world.launchGroup && world.supportsGroup?.() !== false
      ? evaluated.filter(e => validRoute(e.route) && e.route.travelMs <= settings.maxTravelMs && !snapshot.incoming.has(e.target.planetId) && !fleetsFor(snapshot, e.target.planetId).length)
        .sort((a, b) => a.route!.travelMs - b.route!.travelMs) : [];
    const picked = [...new Map([...solos, ...groupCandidates].map(e => [e.target.planetId, e])).values()].slice(0, settings.candidates);
    continuation?.finish(picked.map(e => e.target.planetId));
    const routes = evaluated.flatMap(e => e.quote ? [e.quote.travelMs] : validRoute(e.route) ? [e.route.travelMs] : []);
    if (routes.length && routes.every(time => time > settings.maxTravelMs)) report.reason = `最近航程约 ${Math.ceil(Math.min(...routes) / 1000)} 秒，超过最长航行 ${settings.maxTravelMs / 1000} 秒`;
    else if (!routes.length) report.reason = !evaluated.length && impossible ? '单星及可协同来源兵力不足：按攻击加成上界仍无法占领' : '当前没有有效原生报价 / 航线';
    if (evaluated.length < eligible.length) report.reason += `（本轮评估 ${evaluated.length}/${eligible.length} 个目标${continuation?.deferred ? '，剩余候选下轮续查' : ''}）`;
    for (const { target, quote, route } of picked) {
      if (quote && quote.count <= available) edges.push({ ...quote, value: value(target, quote.travelMs),
        reason: exposed.has(target.planetId) ? '快速铺开：接受前沿暴露，保持占点数优先' : '快速铺开：可执行的无主星球，优先占点数与短航程' });
      // Existing waves use the single-source deficit path; do not mix two coalition plans.
      if (settings.maxSources > 1 && world.launchGroup && world.supportsGroup?.() !== false && !snapshot.incoming.has(target.planetId) && !fleetsFor(snapshot, target.planetId).length) {
        if (validRoute(route) && route.travelMs <= settings.maxTravelMs) {
          const group = groups.get(target.planetId) ?? { target, sources: [] };
          group.sources.push({ planet: source, available, ...route }); groups.set(target.planetId, group);
        }
      }
    }
  }
  progress?.(sources.length, sources.length);
  for (const { target, sources } of groups.values()) {
    yield;
    for (const group of cooperationGroups(sources, settings.maxSources)) {
      yield;
      edges.push(...coalitionOptions(target, group, { ...settings, horizonMs: settings.maxTravelMs }).map(job => ({ ...job, value: value(target, Math.max(job.travelMs, ...(job.support ?? []).map(m => m.travelMs))) })));
    }
  }
  const ready = new Set<bigint>();
  for (const [i, job] of edges.entries()) {
    if (i % 128 === 0) yield;
    for (const m of members(job)) ready.add(m.sourceId);
  }
  for (const report of reports) if (ready.has(report.sourceId)) report.reason = '可出兵；当前目标优先分给更快来源或受剩余预算限制';
  return { edges, candidates: seen.size, sources: reports, readySources: ready.size, exposed: exposed.size,
    ...(search?.deferredSources ? { deferredSources: search.deferredSources } : {}) };
}

export function refreshGroup(world: ExpansionWorld, snapshot: WorldSnapshot, job: Assignment, budgets: Map<bigint, number>, settings: ExpansionSettings): Assignment | null {
  const target = snapshot.planets.find(p => p.planetId === job.targetId);
  if (!target || target.ownerId != null || snapshot.incoming.has(target.planetId) || fleetsFor(snapshot, target.planetId).length) return null;
  const sources: GroupSource[] = [];
  for (const m of [job, ...(job.support ?? [])]) {
    const planet = snapshot.owned.find(p => p.planetId === m.sourceId), route = world.route?.(m.sourceId, job.targetId);
    if (!planet || !validRoute(route)) return null;
    sources.push({ planet, ...route, available: budgets.get(m.sourceId) ?? 0 });
  }
  const solos = sources.flatMap(source => {
    const quote = world.quote(source.planet.planetId, target.planetId);
    return quote && Number.isSafeInteger(quote.count) && quote.count > 0 && quote.count <= source.available && quote.travelMs <= settings.maxTravelMs
      ? [{ ...quote, sourceId: source.planet.planetId, targetId: target.planetId }] : [];
  }).sort((a, b) => a.count - b.count || a.travelMs - b.travelMs);
  if (solos.length) return solos[0];
  const original = [job, ...(job.support ?? [])];
  const deviation = (j: Assignment) => [j, ...(j.support ?? [])].reduce((n, m) => n + Math.abs(m.count - (original.find(o => o.sourceId === m.sourceId)?.count ?? 0)), 0);
  return coalitionOptions(target, sources, { ...settings, horizonMs: settings.maxTravelMs }).sort((a, b) => deviation(a) - deviation(b))[0] ?? null;
}
