import type { Planet } from '../game/types';
import { distance } from './distance';

/** Local spatial lookup avoids rescanning an entire empire for every source. */
export class PlanetIndex {
  private cells = new Map<string, Planet[]>();
  constructor(planets: Planet[]) {
    for (const p of planets) {
      const key = `${Math.floor(p.positionX / 32)},${Math.floor(p.positionY / 32)}`;
      const cell = this.cells.get(key) ?? []; cell.push(p); this.cells.set(key, cell);
    }
  }
  near(source: Planet, radius: number): Planet[] {
    const result: Planet[] = [];
    for (let x = Math.floor((source.positionX - radius) / 32); x <= Math.floor((source.positionX + radius) / 32); x++) {
      for (let y = Math.floor((source.positionY - radius) / 32); y <= Math.floor((source.positionY + radius) / 32); y++) {
        for (const p of this.cells.get(`${x},${y}`) ?? []) if (distance(source, p) <= radius) result.push(p);
      }
    }
    return result;
  }
}
