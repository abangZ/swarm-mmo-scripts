import type { Planet } from '../../game/types';
import type { WorldSnapshot } from '../expansion/world';
import { fleetsFor } from '../expansion/world';
import type { ModeConfig } from './types';
import { inZone } from './types';
import { PlanetIndex } from '../../shared/planet-index';

export function hostile(p: Planet, snapshot: WorldSnapshot): boolean {
  const owner = p.ownerId?.toHexString();
  return !!owner && owner !== snapshot.identity && !snapshot.allies?.has(owner);
}
/** Cover every hostile arrival prefix at 2x Assault; only credit minimum level production. */
export function reserveFor(p: Planet, snapshot: WorldSnapshot, configs: ModeConfig[], enemies = new PlanetIndex(snapshot.planets.filter(target => hostile(target, snapshot)))): number {
  const applicable = configs.filter(c => inZone(p, c.policy.zone));
  let reserve = Math.max(0, ...applicable.map(c => c.settings.reserve));
  if (snapshot.automated?.has(p.planetId)) return Infinity;
  if (!snapshot.intelligence) return reserve; // Legacy/test adapters have no dynamic intelligence.
  const stock = snapshot.budgets.get(p.planetId) ?? 0;
  for (const c of applicable) {
    if (enemies.near(p, c.policy.threatRadius).length) {
      reserve = Math.max(reserve, Math.ceil(stock * c.policy.frontlinePercent / 100));
    }
  }
  const hostileFleets = [];
  for (const fleet of fleetsFor(snapshot, p.planetId)) {
    if (fleet.owner === snapshot.identity || snapshot.allies?.has(fleet.owner)) continue;
    if (fleet.count === null || fleet.arrival === null || !Number.isFinite(fleet.arrival) || !Number.isSafeInteger(fleet.count) || fleet.count < 0) return Infinity;
    hostileFleets.push(fleet);
  }
  let cumulative = 0, requiredNow = 0;
  const level = Number.isInteger(p.level) && p.level! >= 1 && p.level! <= 10 ? p.level! : 0;
  const now = Date.now();
  for (const fleet of hostileFleets.sort((a, b) => a.arrival! - b.arrival!)) {
    cumulative += fleet.count! * 2;
    // One full production tick of slack. No predicted tech, allied supplies, or
    // uncaptured planets are counted; each earlier wave must also be survivable.
    const production = Math.floor(Math.max(0, fleet.arrival! - now - 60000) / 60000) * level;
    requiredNow = Math.max(requiredNow, cumulative + 2 - production);
  }
  return reserve + requiredNow;
}
export function availableBudgets(snapshot: WorldSnapshot, configs: ModeConfig[], debits: Map<bigint, number>): Map<bigint, number> {
  const enemies = new PlanetIndex(snapshot.planets.filter(target => hostile(target, snapshot)));
  return new Map(snapshot.owned.map(p => [p.planetId, Math.max(0, (snapshot.budgets.get(p.planetId) ?? 0) - reserveFor(p, snapshot, configs, enemies) - (debits.get(p.planetId) ?? 0))]));
}
