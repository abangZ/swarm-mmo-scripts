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
/** Upper bound: incoming Assault is at most 2x; do not credit our Defense or future production. */
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
  let incoming = 0;
  for (const fleet of fleetsFor(snapshot, p.planetId)) {
    if (fleet.owner === snapshot.identity || snapshot.allies?.has(fleet.owner)) continue;
    if (fleet.count === null || fleet.arrival === null) return Infinity;
    incoming += fleet.count * 2;
  }
  return reserve + (incoming ? incoming + 2 : 0);
}
export function availableBudgets(snapshot: WorldSnapshot, configs: ModeConfig[], debits: Map<bigint, number>): Map<bigint, number> {
  const enemies = new PlanetIndex(snapshot.planets.filter(target => hostile(target, snapshot)));
  return new Map(snapshot.owned.map(p => [p.planetId, Math.max(0, (snapshot.budgets.get(p.planetId) ?? 0) - reserveFor(p, snapshot, configs, enemies) - (debits.get(p.planetId) ?? 0))]));
}
