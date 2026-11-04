import { fleetsFor, type ExpansionWorld, type WorldSnapshot } from './world';
import type { ModeConfig } from '../commander/types';
import { inZone } from '../commander/types';
import { PlanetIndex } from '../../shared/planet-index';
import { bestCandidates } from '../../shared/best-candidates';
import { expansionQuote, neutralRemaining } from './proposals';
import { riskEvaluator } from './strategy';
import { completionMs, members, totalCount, type Assignment } from './types';
import { coalitionOptions, cooperationGroups, cooperationRadius, validRoute, type GroupSource } from './cooperation';
import { distance } from '../../shared/distance';

/** Small, independent drafts let reinforcements work before the empire-wide plan finishes. */
export class FrontierPlanner {
  private stocks = new Map<bigint, number>();
  private checked = new Map<bigint, number>();
  private initializedAt?: number;
  reset() { this.stocks.clear(); this.checked.clear(); this.initializedAt = undefined; }
  *steps(world: ExpansionWorld, snapshot: WorldSnapshot, config: ModeConfig, budgets: Map<bigint, number>, locked: Set<bigint>, refill: boolean): Generator<void, Assignment[]> {
    const now = Date.now();
    if (this.initializedAt === undefined) {
      this.initializedAt = now;
      this.stocks = new Map(snapshot.budgets);
      return [];
    }
    const sources = snapshot.owned.filter(p => inZone(p, config.policy.zone) && (budgets.get(p.planetId) ?? 0) > 0);
    const grouped = config.settings.maxSources > 1 && !!world.launchGroup && !!world.route && world.supportsGroup?.() !== false;
    const multiplier = snapshot.attackMultiplierUpperBound;
    const power = (stock: number) => multiplier !== undefined && Number.isFinite(multiplier) && multiplier >= 1 ? Math.ceil(stock * multiplier) : Infinity;
    const gain = (id: bigint) => (snapshot.budgets.get(id) ?? 0) - (this.stocks.get(id) ?? 0);
    const changed = sources.filter(p => gain(p.planetId) >= Math.max(20, (this.stocks.get(p.planetId) ?? 0) * 0.1));
    const candidates = [...changed.sort((a, b) => gain(b.planetId) - gain(a.planetId)),
      ...(refill && now - this.initializedAt >= 2000 ? sources.filter(p => now - (this.checked.get(p.planetId) ?? 0) >= 5000)
        .sort((a, b) => (this.checked.get(a.planetId) ?? 0) - (this.checked.get(b.planetId) ?? 0)
          || (budgets.get(b.planetId) ?? 0) - (budgets.get(a.planetId) ?? 0)) : [])];
    // Follow decreases immediately; leave unprocessed reinforcements pending.
    for (const [id, stock] of snapshot.budgets) if (stock < (this.stocks.get(id) ?? 0)) this.stocks.set(id, stock);
    if (!candidates.length) return [];
    const available = new Map(budgets), sourceIndex = new PlanetIndex(grouped ? sources : []);
    const index = new PlanetIndex(snapshot.planets.filter(p => p.ownerId == null && inZone(p, config.policy.zone)
      && !locked.has(p.planetId) && neutralRemaining(p, snapshot, Infinity) !== null));
    const risk = riskEvaluator(snapshot, config), visited = new Set<bigint>(), jobs: Assignment[] = [];
    let evaluated = 0, evaluations = 0;
    for (const source of candidates) {
      yield;
      const id = source.planetId;
      if (visited.has(id)) continue;
      visited.add(id);
      this.checked.set(id, now); this.stocks.set(id, snapshot.budgets.get(id) ?? 0);
      const inRange = index.near(source, config.settings.radius);
      if (!inRange.length) continue;
      const peers = grouped ? sourceIndex.near(source, cooperationRadius).filter(p => p.planetId !== id && (available.get(p.planetId) ?? 0) > 0) : [];
      const strongest = bestCandidates(peers, 20, p => -(available.get(p.planetId) ?? 0));
      const jointPower = power(available.get(id) ?? 0) + strongest.slice(0, config.settings.maxSources - 1).reduce((n, p) => n + power(available.get(p.planetId) ?? 0), 0);
      // Unaffordable neighbors must not fill the bounded nearest-target list or
      // spend one of the four source slots without a single useful quote.
      const nearby = inRange.filter(target => jointPower > target.probeCount || fleetsFor(snapshot, target.planetId).length);
      if (!nearby.length) continue;
      let count = 0, groupTargets = 0;
      for (const target of bestCandidates(nearby, 32, p => (p.positionX - source.positionX) ** 2 + (p.positionY - source.positionY) ** 2)) {
        yield;
        if (locked.has(target.planetId) || config.settings.cautiousExpansion && risk(target) === 'exposed') continue;
        if (evaluations >= 96) break;
        const hasFleet = fleetsFor(snapshot, target.planetId).length > 0;
        let job: Assignment | null = null;
        if (power(available.get(id) ?? 0) > target.probeCount || hasFleet) {
          evaluations++;
          job = expansionQuote(world, snapshot, source, target, config);
          if (job && job.count > (available.get(id) ?? 0)) job = null;
        }
        if (!job && grouped && !hasFleet && !snapshot.incoming.has(target.planetId) && groupTargets++ < 4) {
          // At most 20 neighbors and four coalition targets per anchor; the
          // entire fast pass shares a 96-evaluation cap. No empire-wide search.
          const close = bestCandidates(peers, 10, p => distance(p, target));
          const pool = [...new Map([...close, ...strongest].map(p => [p.planetId, p])).values()].slice(0, 20);
          const routes: GroupSource[] = [], options: Assignment[] = [];
          for (const p of [source, ...pool]) {
            yield;
            const stock = available.get(p.planetId) ?? 0;
            if (!stock || distance(p, target) > config.settings.radius) continue;
            if (evaluations >= 96) break;
            evaluations++;
            const route = world.route!(p.planetId, target.planetId);
            if (!validRoute(route) || route.travelMs > config.settings.maxTravelMs) continue;
            routes.push({ planet: p, available: stock, ...route });
            // Prefer an affordable single neighbor over splitting its army.
            // route() and quote() share the native planning cache.
            if (p.planetId !== id && power(stock) > target.probeCount) {
              const solo = expansionQuote(world, snapshot, p, target, config);
              if (solo && solo.count <= stock) options.push(solo);
            }
          }
          for (const group of cooperationGroups(routes, config.settings.maxSources)) {
            yield;
            options.push(...coalitionOptions(target, group, { ...config.settings, horizonMs: config.settings.maxTravelMs }));
          }
          job = options.sort((a, b) => members(a).length - members(b).length || completionMs(a) - completionMs(b) || totalCount(a) - totalCount(b))[0] ?? null;
        }
        if (!job) continue;
        jobs.push({ ...job, reason: job.support?.length ? '前线快速合兵：附近来源协同占领' : '前线快速补充：附近可占领目标' });
        locked.add(target.planetId);
        for (const m of members(job)) available.set(m.sourceId, (available.get(m.sourceId) ?? 0) - m.count);
        if (++count >= 3) break;
      }
      // Publish the first productive source immediately, rather than holding
      // its jobs until three other potentially expensive sources finish.
      if (++evaluated >= 4 || jobs.length || evaluations >= 96) break;
    }
    return jobs.sort((a, b) => a.travelMs - b.travelMs);
  }
}
