import { fingerprint } from '../../shared/fingerprint';
import type { ExpansionWorld, WorldSnapshot } from './world';
import { targetKey, type TargetKind } from './types';
import type { Route } from './cooperation';
import { globalQuoteRules, sourceQuoteRules } from './quote-rules';

type Quote = ReturnType<ExpansionWorld['quote']>;
interface Entry { source: string; rules: string; target: string; quote: Quote; route: Route | null; expires: number; issue?: string }

/** Reuse neutral-body planning quotes, not dispatch checks or enemy predictions. */
export class PlanningQuotes {
  private version?: string;
  private adapter?: ExpansionWorld;
  private entries = new Map<string, Entry>();
  stats = { fresh: 0, reused: 0 };
  clear() { this.entries.clear(); this.version = undefined; this.adapter = undefined; }
  begin(world: ExpansionWorld, snapshot: WorldSnapshot): ExpansionWorld {
    const version = globalQuoteRules(snapshot);
    if (world !== this.adapter || version === undefined || version !== this.version) this.entries.clear();
    this.adapter = world; this.version = version;
    this.stats = { fresh: 0, reused: 0 };
    if (snapshot.quoteVersion === undefined) return world;
    // Fast passes touch only a handful of routes. Index rows once, then encode
    // dependencies only when a route is actually inspected, not all 4,000 stars.
    const sources = new Map(snapshot.owned.map(p => [p.planetId, p]));
    const targetRows = new Map<string, unknown>();
    for (const p of snapshot.planets) if (p.ownerId == null) targetRows.set(targetKey(p.planetId), p);
    for (const p of snapshot.suns ?? []) if (p.ownerId == null) targetRows.set(targetKey(p.sunId, 'sun'), p);
    for (const p of snapshot.meteorites ?? []) if (p.ownerId == null) targetRows.set(targetKey(p.meteoriteId, 'comet'), p);
    const stock = new Map<bigint, string>(), rules = new Map<bigint, string>(), targets = new Map<string, string>();
    const sourceStock = (id: bigint) => {
      if (!sources.has(id)) return undefined;
      if (!stock.has(id)) stock.set(id, fingerprint([sources.get(id), snapshot.budgets.get(id)]));
      return stock.get(id);
    };
    const sourceRule = (id: bigint) => {
      const p = sources.get(id); if (!p) return undefined;
      if (!rules.has(id)) rules.set(id, fingerprint([sourceQuoteRules(snapshot, id), id, p.ownerId, p.positionX, p.positionY, p.galaxyId, p.level]));
      return rules.get(id);
    };
    const targetState = (key: string) => {
      if (!targetRows.has(key)) return undefined;
      if (!targets.has(key)) targets.set(key, fingerprint(targetRows.get(key)));
      return targets.get(key);
    };
    const round = new Map<string, Entry>();
    const reusedRoutes = new Set<string>();
    const cacheable = (source: bigint, target: bigint, kind: TargetKind = 'planet') => sources.has(source) && targetRows.has(targetKey(target, kind));
    const get = (sourceId: bigint, targetId: bigint, kind: TargetKind = 'planet'): Entry => {
      const key = `${sourceId}:${targetKey(targetId, kind)}`;
      const source = sourceStock(sourceId), target = targetState(targetKey(targetId, kind));
      const rules = sourceRule(sourceId);
      const reusable = snapshot.quoteVersion !== undefined && source !== undefined && target !== undefined;
      const local = round.get(key);
      if (local && Date.now() < local.expires) return local;
      const previous = reusable ? this.entries.get(key) : undefined;
      // A successful neutral capture price does not depend on how many spare
      // probes the source owns. Availability is checked against the new budget.
      // Failed/insufficient quotes still depend on stock and must be refreshed.
      if (previous && previous.rules === rules && (previous.source === source || previous.quote !== null)
        && previous.target === target && Date.now() < previous.expires) {
        if (!reusedRoutes.has(key)) this.stats.reused++;
        round.set(key, previous); return previous;
      }
      this.stats.fresh++;
      const route = kind === 'planet' ? world.route?.(sourceId, targetId) : world.routeBody?.(sourceId, targetId, kind);
      const quote = kind === 'planet' ? world.quote(sourceId, targetId) : world.quoteBody?.(sourceId, targetId, kind);
      const entry = { source: source ?? '', rules: rules ?? '', target: target ?? '', quote: quote ?? null, route: route ?? null,
        issue: !quote && kind !== 'planet' ? world.bodyQuoteIssue?.(sourceId, targetId, kind) : undefined,
        expires: Date.now() + (route ? 600000 : 5000) };
      // Missing version support and owned/enemy targets stay on fresh native
      // quotes. Neutral snapshots have no time-dependent enemy production.
      if (reusable) {
        round.set(key, entry);
        this.entries.delete(key); this.entries.set(key, entry);
        if (this.entries.size > 100000) this.entries.delete(this.entries.keys().next().value!);
      }
      return entry;
    };
    const getRoute = (sourceId: bigint, targetId: bigint, kind: TargetKind = 'planet') => {
      const key = `${sourceId}:${targetKey(targetId, kind)}`;
      const previous = this.entries.get(key);
      // Cooperation asks only for travel/loss. A prior insufficient single
      // capture must not force the same geometry through quoteSend every time
      // the source produces a probe. quote() still refreshes failed prices.
      if (previous?.route && previous.rules === sourceRule(sourceId)
        && previous.target === targetState(targetKey(targetId, kind)) && Date.now() < previous.expires) {
        if (!round.has(key) && !reusedRoutes.has(key)) { this.stats.reused++; reusedRoutes.add(key); }
        return previous.route;
      }
      return get(sourceId, targetId, kind).route;
    };
    const overrides = {
      quote: (source: bigint, target: bigint) => cacheable(source, target) ? get(source, target).quote : world.quote(source, target),
      route: world.route ? (source: bigint, target: bigint) => cacheable(source, target) ? getRoute(source, target) : world.route!(source, target) : undefined,
      quoteBody: world.quoteBody ? (source: bigint, target: bigint, kind: 'sun' | 'comet') => cacheable(source, target, kind) ? get(source, target, kind).quote : world.quoteBody!(source, target, kind) : undefined,
      routeBody: world.routeBody ? (source: bigint, target: bigint, kind: 'sun' | 'comet') => cacheable(source, target, kind) ? getRoute(source, target, kind) : world.routeBody!(source, target, kind) : undefined,
      bodyQuoteIssue: world.bodyQuoteIssue ? (source: bigint, target: bigint, kind: 'sun' | 'comet') => cacheable(source, target, kind) ? get(source, target, kind).issue : world.bodyQuoteIssue!(source, target, kind) : undefined,
    };
    return new Proxy(world, { get(target, key) {
      if (key in overrides) return overrides[key as keyof typeof overrides];
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
}
