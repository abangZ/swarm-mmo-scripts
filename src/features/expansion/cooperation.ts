import type { Assignment, Contribution, ExpansionSettings } from './types';
import type { Planet } from '../../game/types';
import { distance } from '../../shared/distance';
import { captureMargin } from './types';

export const cooperationRadius = 8;
export const arrivalSpreadMs = 15000;
export interface Route { travelMs: number; lossPct: number }
export interface GroupSource extends Route { planet: Planet; available: number }
export function validRoute(route: Route | null | undefined): route is Route {
  return !!route && Number.isFinite(route.travelMs) && route.travelMs >= 0 && Number.isInteger(route.lossPct) && route.lossPct >= 0 && route.lossPct < 100;
}
export function arriving(count: number, lossPct: number): number { return Math.floor(count * (100 - lossPct) / 100); }
function permutations<T>(items: T[]): T[][] {
  return items.length < 2 ? [items] : items.flatMap((item, i) => permutations(items.filter((_, j) => i !== j)).map(tail => [item, ...tail]));
}
// Neutral planets have no owner technology or production. Ignoring attacker Assault is conservative.
// Allocate garrison + 1 to win, plus the shared arrival margin after per-fleet tolls.
export function coalitionOptions(target: Planet, sources: GroupSource[], settings: ExpansionSettings): Assignment[] {
  if (target.ownerId != null || sources.length < 2 || sources.length > settings.maxSources || sources.length > 3) return [];
  if (new Set(sources.map(s => s.planet.planetId)).size !== sources.length) return [];
  if (!Number.isSafeInteger(target.probeCount) || target.probeCount < 0) return [];
  for (const source of sources) {
    if (source.planet.ownerId == null || source.planet.planetId === target.planetId || !validRoute(source) || !Number.isSafeInteger(source.available) || source.available < 1 || distance(source.planet, target) > settings.radius || source.travelMs > settings.horizonMs) return [];
    if (sources.some(other => distance(source.planet, other.planet) > cooperationRadius)) return [];
  }
  if (Math.max(...sources.map(s => s.travelMs)) - Math.min(...sources.map(s => s.travelMs)) > arrivalSpreadMs) return [];
  const required = target.probeCount + 1 + captureMargin;
  const results = new Map<string, Assignment>();
  for (const ordered of permutations(sources)) {
    // Greedy and balanced variants leave different sources available to attack other targets.
    for (const balanced of [false, true]) {
      let remaining = required;
      const members: Contribution[] = [];
      for (let i = 0; i < ordered.length; i++) {
        const source = ordered[i], later = ordered.slice(i + 1);
        const capacity = arriving(source.available, source.lossPct);
        const futureCapacity = later.reduce((n, s) => n + arriving(s.available, s.lossPct), 0);
        const minimum = Math.max(1, remaining - futureCapacity);
        const maximum = Math.min(capacity, remaining - later.length);
        if (maximum < minimum) break;
        const contribution = balanced ? Math.max(minimum, Math.min(maximum, Math.ceil(remaining / (later.length + 1)))) : maximum;
        const count = Math.ceil(contribution * 100 / (100 - source.lossPct));
        if (count > source.available || count > 0xffffffff || arriving(count, source.lossPct) < contribution) break;
        members.push({ sourceId: source.planet.planetId, count, travelMs: source.travelMs });
        remaining -= arriving(count, source.lossPct);
      }
      if (members.length !== sources.length || remaining > 0) continue;
      members.sort((a, b) => a.sourceId < b.sourceId ? -1 : 1);
      const [lead, ...support] = members;
      const key = members.map(m => `${m.sourceId}:${m.count}`).join(',');
      results.set(key, { ...lead, targetId: target.planetId, support });
    }
  }
  return [...results.values()];
}
export function combinations<T>(items: T[], size: number): T[][] {
  if (size === 0) return [[]];
  return items.flatMap((item, i) => combinations(items.slice(i + 1), size - 1).map(tail => [item, ...tail]));
}
