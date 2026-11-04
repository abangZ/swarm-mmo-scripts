import type { Connection, Planet } from './types';
import { PlanetIndex } from '../shared/planet-index';

/** Mirrors native _x/He: construction changes the tick period only under friendly influence.
 * Reads SDK tables only. Production is used for forecasts, never as current stock. */
export class ProductionTicks {
  private version?: string;
  private cache = new Map<bigint, { x: number; y: number; tick: number; covered: boolean }>();
  covered(source: bigint) { return this.cache.get(source)?.covered ?? false; }
  private coverage?: PlanetIndex;
  private radii = new Map<bigint, number>();
  read(db: Connection['db'], owned: Planet[], allies: Set<string>, identity: string, version: string) {
    if (version !== this.version) {
      this.version = version; this.cache.clear(); this.radii.clear();
      const points: Planet[] = [];
      const add = (x: number, y: number, radius: number) => {
        if (![x, y, radius].every(Number.isFinite)) return;
        const id = BigInt(points.length); this.radii.set(id, radius);
        points.push({ planetId: id, positionX: x, positionY: y, probeCount: 0, galaxyId: 0n });
      };
      for (const sun of db.sun2?.iter() ?? []) if (sun.ownerId && allies.has(sun.ownerId.toHexString())) add(sun.positionX, sun.positionY, 8);
      for (const value of db.base?.iter() ?? []) {
        const base = value as { ownerId?: { toHexString(): string }; superprobes?: number; positionX: number; positionY: number; level: number };
        if (base.ownerId && allies.has(base.ownerId.toHexString()) && (base.superprobes ?? 0) > 0) add(base.positionX, base.positionY, Math.min(base.level, 10));
      }
      this.coverage = new PlanetIndex(points);
    }
    const construction = [...db.player_tech?.iter() ?? []].find(t => t.playerId.toHexString() === identity)?.construction ?? 0;
    const accelerated = Number.isInteger(construction) && construction >= 0 ? Math.floor(60000 / (1 + 0.005 * construction)) : 60000;
    const result = new Map<bigint, number>();
    for (const p of owned) {
      let cached = this.cache.get(p.planetId);
      if (!cached || cached.x !== p.positionX || cached.y !== p.positionY) {
        const covered = this.coverage?.near(p, 10).some(center => (center.positionX - p.positionX) ** 2 + (center.positionY - p.positionY) ** 2 <= this.radii.get(center.planetId)! ** 2);
        cached = { x: p.positionX, y: p.positionY, tick: covered ? accelerated : 60000, covered: !!covered }; this.cache.set(p.planetId, cached);
      }
      result.set(p.planetId, cached.tick);
    }
    for (const id of this.cache.keys()) if (!result.has(id)) this.cache.delete(id);
    return result;
  }
}
