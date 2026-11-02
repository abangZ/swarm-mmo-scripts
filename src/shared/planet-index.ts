import type { Planet } from '../game/types';

/** Local spatial lookup avoids rescanning an entire empire for every source. */
export class PlanetIndex {
  private cells = new Map<string, Planet[]>();
  constructor(planets: Planet[]) {
    for (const p of planets) {
      const key = `${Math.floor(p.positionX / 32)},${Math.floor(p.positionY / 32)}`;
      const cell = this.cells.get(key) ?? []; cell.push(p); this.cells.set(key, cell);
    }
  }
  /** Same tie order as every near() query: cell x, cell y, then insertion order. */
  ordered(): Planet[] {
    return [...this.cells.entries()].map(([key, planets]) => ({ cell: key.split(',').map(Number), planets }))
      .sort((a, b) => a.cell[0] - b.cell[0] || a.cell[1] - b.cell[1]).flatMap(entry => entry.planets);
  }
  near(source: Planet, radius: number): Planet[] {
    const result: Planet[] = [];
    for (let x = Math.floor((source.positionX - radius) / 32); x <= Math.floor((source.positionX + radius) / 32); x++) {
      for (let y = Math.floor((source.positionY - radius) / 32); y <= Math.floor((source.positionY + radius) / 32); y++) {
        for (const p of this.cells.get(`${x},${y}`) ?? []) {
          const dx = source.positionX - p.positionX, dy = source.positionY - p.positionY;
          if (dx * dx + dy * dy <= radius * radius) result.push(p);
        }
      }
    }
    return result;
  }
}
