import type { ExpansionWorld, WorldSnapshot } from './world';
import { fleetsFor } from './world';
import { captureMargin, members, type Assignment, type ExpansionSettings } from './types';
import { coalitionOptions, combinations, validRoute, type GroupSource } from './cooperation';
import type { Planet } from '../../game/types';
import type { ModeConfig } from '../commander/types';
import { inZone } from '../commander/types';
import { distance } from '../../shared/distance';
import { PlanetIndex } from '../../shared/planet-index';

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
export function expansionProposals(world: ExpansionWorld, snapshot: WorldSnapshot, config: ModeConfig, budgets: Map<bigint, number>, locked: Set<bigint>): { edges: Assignment[]; candidates: number; sources: SourceReport[]; readySources: number } {
  const { settings } = config;
  const neutrals = snapshot.planets.filter(p => p.ownerId == null && inZone(p, config.policy.zone));
  const targets = neutrals.filter(p => !locked.has(p.planetId) && neutralRemaining(p, snapshot, Infinity) !== null);
  const allIndex = new PlanetIndex(neutrals);
  const index = new PlanetIndex(targets), frontier = new Map<bigint, number>();
  const opportunity = (p: Planet) => {
    if (!frontier.has(p.planetId)) frontier.set(p.planetId, Math.min(10, index.near(p, Math.min(settings.radius, 8)).filter(q => q.planetId !== p.planetId && q.probeCount <= p.probeCount + 10).length));
    return frontier.get(p.planetId)!;
  };
  const value = (p: Planet, travelMs: number) => (p.level ?? 1) * Math.max(0, settings.horizonMs - travelMs) / 60000 + opportunity(p) * 0.1;
  const edges: Assignment[] = [], seen = new Set<bigint>();
  const reports: SourceReport[] = [];
  const groups = new Map<bigint, { target: Planet; sources: GroupSource[] }>();
  for (const source of snapshot.owned.filter(p => inZone(p, config.policy.zone))) {
    const available = budgets.get(source.planetId) ?? 0;
    const report = { sourceId: source.planetId, x: source.positionX, y: source.positionY, available, reason: '单星兵力不足或报价不可用，暂时没有可行协同' };
    reports.push(report);
    if (available <= 0) { report.reason = '无可用兵力：已扣除留守、进攻预留及待同步的发射'; continue; }
    const eligible = index.near(source, settings.radius);
    if (!eligible.length) {
      report.reason = allIndex.near(source, settings.radius).length ? '范围内目标已在途或锁定，避免重复发射' : '搜索距离 / 战区内没有无主星';
      continue;
    }
    const orders = [
      [...eligible].sort((a, b) => distance(source, a) - distance(source, b)),
      [...eligible].sort((a, b) => a.probeCount - b.probeCount),
      [...eligible].sort((a, b) => (b.level ?? 1) / (b.probeCount + 1 + captureMargin) - (a.level ?? 1) / (a.probeCount + 1 + captureMargin)),
      [...eligible].sort((a, b) => opportunity(b) - opportunity(a)),
    ];
    // Backfill n with feasible opportunities, rather than letting nearby unaffordable
    // or overly slow targets use all candidate slots. Bound native quote work per source.
    const pool = new Map<bigint, Planet>();
    const limit = Math.max(32, settings.candidates * 8);
    for (let i = 0; pool.size < limit && i < eligible.length; i++) for (const order of orders) {
      if (order[i] && pool.size < limit) pool.set(order[i].planetId, order[i]);
    }
    const evaluated: { target: Planet; quote: Assignment | null; route: ReturnType<NonNullable<ExpansionWorld['route']>> | undefined }[] = [];
    let affordable = 0;
    for (const target of pool.values()) {
      const quote = expansionQuote(world, snapshot, source, target, config);
      evaluated.push({ target, quote, route: world.route?.(source.planetId, target.planetId) });
      if (quote && quote.count <= available) affordable++;
      if (affordable >= settings.candidates && evaluated.length >= settings.candidates * 2) break;
    }
    for (const { target } of evaluated) seen.add(target.planetId);
    const solos = evaluated.filter(e => e.quote && e.quote.count <= available).sort((a, b) => a.quote!.travelMs - b.quote!.travelMs || a.quote!.count - b.quote!.count);
    const groupCandidates = settings.maxSources > 1 && world.launchGroup && world.supportsGroup?.() !== false
      ? evaluated.filter(e => validRoute(e.route) && e.route.travelMs <= settings.maxTravelMs && !snapshot.incoming.has(e.target.planetId) && !fleetsFor(snapshot, e.target.planetId).length)
        .sort((a, b) => a.route!.travelMs - b.route!.travelMs) : [];
    const picked = [...new Map([...solos, ...groupCandidates].map(e => [e.target.planetId, e])).values()].slice(0, settings.candidates);
    const routes = evaluated.flatMap(e => e.quote ? [e.quote.travelMs] : validRoute(e.route) ? [e.route.travelMs] : []);
    if (routes.length && routes.every(time => time > settings.maxTravelMs)) report.reason = `最近航程约 ${Math.ceil(Math.min(...routes) / 1000)} 秒，超过最长航行 ${settings.maxTravelMs / 1000} 秒`;
    else if (!routes.length) report.reason = '当前没有有效原生报价 / 航线';
    if (evaluated.length < eligible.length) report.reason += `（本轮评估 ${evaluated.length}/${eligible.length} 个目标）`;
    for (const { target, quote, route } of picked) {
      if (quote && quote.count <= available) edges.push({ ...quote, value: value(target, quote.travelMs) });
      // Existing waves use the single-source deficit path; do not mix two coalition plans.
      if (settings.maxSources > 1 && world.launchGroup && world.supportsGroup?.() !== false && !snapshot.incoming.has(target.planetId) && !fleetsFor(snapshot, target.planetId).length) {
        if (validRoute(route) && route.travelMs <= settings.maxTravelMs) {
          const group = groups.get(target.planetId) ?? { target, sources: [] };
          group.sources.push({ planet: source, available, ...route }); groups.set(target.planetId, group);
        }
      }
    }
  }
  for (const { target, sources } of groups.values()) {
    const fastest = [...sources].sort((a, b) => a.travelMs - b.travelMs);
    const strongest = [...sources].sort((a, b) => b.available * (100 - b.lossPct) - a.available * (100 - a.lossPct));
    const picked = [...new Map([...fastest.slice(0, 3), ...strongest.slice(0, 3)].map(s => [s.planet.planetId, s])).values()];
    for (let size = 2; size <= settings.maxSources; size++) for (const group of combinations(picked, size)) edges.push(...coalitionOptions(target, group, { ...settings, horizonMs: settings.maxTravelMs }).map(job => ({ ...job, value: value(target, Math.max(job.travelMs, ...(job.support ?? []).map(m => m.travelMs))) })));
  }
  const ready = new Set(edges.flatMap(job => members(job).map(m => m.sourceId)));
  for (const report of reports) if (ready.has(report.sourceId)) report.reason = '可出兵；当前目标优先分给更快来源或受剩余预算限制';
  return { edges, candidates: seen.size, sources: reports, readySources: ready.size };
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
