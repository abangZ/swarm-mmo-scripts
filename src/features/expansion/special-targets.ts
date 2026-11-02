import type { Planet, Sun } from '../../game/types';
import { distance } from '../../shared/distance';
import { bestCandidates } from '../../shared/best-candidates';
import { PlanetIndex } from '../../shared/planet-index';
import { hostile } from '../commander/safety';
import { inZone, type ModeConfig } from '../commander/types';
import { arriving, validRoute } from './cooperation';
import { bodyFleetsFor, fleetsFor, type ExpansionWorld, type WorldSnapshot } from './world';
import { completionMs, members, targetKey, type Assignment, type Contribution } from './types';
import { riskEvaluator } from './strategy';

export function* meteoriteProposals(world: ExpansionWorld, snapshot: WorldSnapshot, config: ModeConfig, budgets: Map<bigint, number>, locked: Set<string>): Generator<void, Assignment[]> {
  if (!config.settings.captureMeteorites || !world.quoteBody || !world.launchBody) return [];
  const risk = riskEvaluator(snapshot, config), jobs: Assignment[] = [];
  const targets = (snapshot.meteorites ?? []).filter(t => t.ownerId == null && inZone(t, config.policy.zone)
    && Number.isFinite(Number(t.expiresAt.toMillis())) && Number(t.expiresAt.toMillis()) > Date.now() + 5000
    && !locked.has(targetKey(t.meteoriteId, 'comet')) && !bodyFleetsFor(snapshot, t.meteoriteId, 'comet').length
    && (!config.settings.cautiousExpansion || risk(t) !== 'exposed'));
  for (const source of snapshot.owned) {
    yield;
    if (!inZone(source, config.policy.zone) || (budgets.get(source.planetId) ?? 0) <= 0) continue;
    const nearby = bestCandidates(targets.filter(t => distance(source, t) <= config.settings.radius), Math.max(8, config.settings.candidates * 2), t => distance(source, t));
    for (const [i, target] of nearby.entries()) {
      if (i % 8 === 0) yield;
      const quote = world.quoteBody(source.planetId, target.meteoriteId, 'comet');
      const expiresAt = Number(target.expiresAt.toMillis());
      if (!quote || quote.count > (budgets.get(source.planetId) ?? 0) || quote.travelMs > config.settings.maxTravelMs
        || Date.now() + quote.travelMs + 5000 >= expiresAt) continue;
      jobs.push({ ...quote, sourceId: source.planetId, targetId: target.meteoriteId, targetKind: 'comet', garrison: target.probeCount, expiresAt,
        value: 0, reason: '可在消失前抵达；陨石不计产能，收益需持有至到期' });
    }
  }
  return jobs;
}

export interface SunPlan { job?: Assignment; reservations: Map<bigint, number>; waiting?: string; hub?: bigint; sun?: bigint }
interface Campaign { hub: bigint; sun: bigint; until: number }

/** At most one affordable nearby sun campaign; small fragments first go to a friendly planet. */
export class SunPlanner {
  private campaign?: Campaign;
  get gathering() { return this.campaign !== undefined; }
  reset() { this.campaign = undefined; }
  fork() { const copy = new SunPlanner(); copy.campaign = this.campaign && { ...this.campaign }; return copy; }
  launched(job: Assignment) {
    if (job.kind === 'sun-supply' && job.sunId !== undefined) this.campaign = { hub: job.targetId, sun: job.sunId, until: Date.now() + completionMs(job) + 30000 };
    else if (job.targetKind === 'sun' && this.campaign?.sun === job.targetId) this.campaign = undefined;
  }
  private safeHub(hub: Planet, snapshot: WorldSnapshot, config: ModeConfig) {
    return inZone(hub, config.policy.zone) && !snapshot.automated?.has(hub.planetId) && !fleetsFor(snapshot, hub.planetId).length
      && !snapshot.planets.some(p => hostile(p, snapshot) && distance(p, hub) <= config.policy.threatRadius);
  }
  *steps(world: ExpansionWorld, snapshot: WorldSnapshot, config: ModeConfig, budgets: Map<bigint, number>, locked: Set<string>, guardPercent = (_hub: Planet) => 0): Generator<void, SunPlan> {
    const empty = (): SunPlan => ({ reservations: new Map() });
    if (!config.settings.captureSuns || !world.quoteBody || !world.routeBody || !world.launchBody || !snapshot.intelligence) return empty();
    const targets = (snapshot.suns ?? []).filter(t => t.ownerId == null && Number.isSafeInteger(t.probeCount) && t.probeCount >= 0 && inZone(t, config.policy.zone)
      && !locked.has(targetKey(t.sunId, 'sun')) && !bodyFleetsFor(snapshot, t.sunId, 'sun').length);
    const sources = snapshot.owned.filter(p => inZone(p, config.policy.zone) && !snapshot.automated?.has(p.planetId));
    const risk = riskEvaluator(snapshot, config);
    if (this.campaign) {
      const { sun, hub, until } = this.campaign;
      const target = targets.find(t => t.sunId === sun), source = sources.find(p => p.planetId === hub);
      if (!target || !source || Date.now() > until || snapshot.planets.some(p => hostile(p, snapshot) && distance(p, source) <= config.policy.threatRadius)
        || fleetsFor(snapshot, hub).some(f => f.owner !== snapshot.identity && !snapshot.allies?.has(f.owner))) this.campaign = undefined;
      else {
        const job = this.quote(world, source, target, config, budgets);
        if (job) return { job, reservations: new Map([[hub, job.count]]), hub, sun };
        // Actual inventory is the only launch authority; in-flight promises are never spendable.
        const route = world.routeBody(hub, sun, 'sun');
        if (!validRoute(route)) { this.campaign = undefined; return empty(); }
        const required = Math.ceil((target.probeCount + 1) * 100 * 100 / (100 - route.lossPct));
        return { reservations: new Map([[hub, Math.min(required, budgets.get(hub) ?? 0)]]), hub, sun, waiting: `恒星 #${sun}：等待碎片兵力抵达星球 #${hub}` };
      }
    }
    if (!targets.length) return empty();
    const enemies = new PlanetIndex(snapshot.planets.filter(p => hostile(p, snapshot)));
    const safeHubs = new Set(sources.filter(p => !fleetsFor(snapshot, p.planetId).length && !enemies.near(p, config.policy.threatRadius).length).map(p => p.planetId));
    let best: Assignment | undefined;
    const routes: { hub: Planet; target: Sun; count: number; travelMs: number }[] = [];
    for (const source of sources) {
      yield;
      if ((budgets.get(source.planetId) ?? 0) <= 0) continue;
      const nearby = bestCandidates(targets.filter(t => distance(source, t) <= config.settings.radius
        && (!config.settings.cautiousExpansion || risk(t) !== 'exposed')), Math.max(8, config.settings.candidates), t => distance(source, t));
      for (const [i, target] of nearby.entries()) {
        if (i % 8 === 0) yield;
        const job = this.quote(world, source, target, config, budgets);
        if (job && (!best || job.travelMs < best.travelMs || job.travelMs === best.travelMs && job.count < best.count)) best = job;
        const route = world.routeBody(source.planetId, target.sunId, 'sun');
        if (validRoute(route) && route.travelMs <= config.settings.maxTravelMs && safeHubs.has(source.planetId)) {
          const count = Math.ceil((target.probeCount + 1) * 100 * 100 / (100 - route.lossPct));
          if (Number.isSafeInteger(count) && count <= 0xffffffff) routes.push({ hub: source, target, count, travelMs: route.travelMs });
        }
      }
    }
    if (best) return { job: best, reservations: new Map([[best.sourceId, best.count]]), sun: best.targetId };
    if (config.settings.maxSources < 2 || !world.launchGroup || world.supportsGroup?.() === false || !world.route) return empty();
    let gathering: { plan: SunPlan; time: number; cost: number } | undefined;
    for (const option of bestCandidates(routes, 16, r => r.travelMs)) {
      yield;
      const { hub, target, count } = option;
      const stock = budgets.get(hub.planetId) ?? 0;
      let remaining = Math.ceil((count - stock) / (1 - guardPercent(hub) / 100));
      if (remaining <= 0) continue; // Missing native quote despite sufficient stock: do not speculate.
      const donors: { planet: Planet; count: number; travelMs: number; lossPct: number }[] = [];
      for (const [i, donor] of sources.entries()) {
        if (i % 32 === 0) yield;
        if (donor.planetId === hub.planetId || distance(donor, hub) > 8 || (budgets.get(donor.planetId) ?? 0) <= 0) continue;
        const route = world.route(donor.planetId, hub.planetId);
        if (validRoute(route) && route.travelMs <= config.settings.maxTravelMs) donors.push({ planet: donor, count: budgets.get(donor.planetId)!, ...route });
      }
      donors.sort((a, b) => a.travelMs - b.travelMs || b.count - a.count);
      // Grow the arrival-time prefix while retaining its strongest contributors.
      // A nearby tiny stock must not exhaust the source cap before a funded route.
      const selected: typeof donors = [];
      let capacity = 0;
      for (const [i, donor] of donors.entries()) {
        if (i % 32 === 0) yield;
        selected.push(donor);
        selected.sort((a, b) => arriving(b.count, b.lossPct) - arriving(a.count, a.lossPct) || a.travelMs - b.travelMs);
        if (selected.length > config.settings.maxSources - 1) selected.pop();
        capacity = selected.reduce((n, d) => n + arriving(d.count, d.lossPct), 0);
        if (capacity >= remaining) break;
      }
      if (capacity < remaining) continue;
      const allocations: Contribution[] = [];
      for (const donor of selected) {
        if (remaining <= 0) break;
        const sent = Math.min(donor.count, Math.ceil(remaining * 100 / (100 - donor.lossPct)));
        if (arriving(sent, donor.lossPct) < 1) continue;
        allocations.push({ sourceId: donor.planet.planetId, count: sent, travelMs: donor.travelMs });
        remaining -= arriving(sent, donor.lossPct);
      }
      if (remaining > 0 || !allocations.length) continue;
      const [lead, ...support] = allocations;
      const job: Assignment = { ...lead, support, targetId: hub.planetId, kind: 'sun-supply', sunId: target.sunId,
        hubBudget: stock, garrison: target.probeCount, reason: `先汇集至己方星球，再以完整超级信标占领恒星 #${target.sunId}` };
      const time = completionMs(job) + option.travelMs, cost = allocations.reduce((n, m) => n + m.count, 0);
      if (!gathering || time < gathering.time || time === gathering.time && cost < gathering.cost) gathering = { time, cost,
        plan: { job, sun: target.sunId, hub: hub.planetId, reservations: new Map([[hub.planetId, stock], ...allocations.map(m => [m.sourceId, m.count] as [bigint, number])]) } };
    }
    return gathering?.plan ?? empty();
  }
  private quote(world: ExpansionWorld, source: Planet, target: Sun, config: ModeConfig, budgets: Map<bigint, number>): Assignment | undefined {
    if (distance(source, target) > config.settings.radius) return;
    const quote = world.quoteBody!(source.planetId, target.sunId, 'sun');
    if (!quote || quote.count > (budgets.get(source.planetId) ?? 0) || quote.travelMs > config.settings.maxTravelMs) return;
    return { ...quote, sourceId: source.planetId, targetId: target.sunId, targetKind: 'sun', garrison: target.probeCount, reason: '附近兵力已足，优先取得恒星能量与科技覆盖' };
  }
  validSupply(job: Assignment, snapshot: WorldSnapshot, config: ModeConfig): boolean {
    const hub = snapshot.owned.find(p => p.planetId === job.targetId), sun = snapshot.suns?.find(p => p.sunId === job.sunId);
    return !!hub && !!sun && sun.ownerId == null && sun.probeCount === job.garrison && inZone(sun, config.policy.zone)
      && this.safeHub(hub, snapshot, config) && !bodyFleetsFor(snapshot, sun.sunId, 'sun').length
      && members(job).every(m => { const donor = snapshot.owned.find(p => p.planetId === m.sourceId); return !!donor && distance(donor, hub) <= 8; });
  }
}
