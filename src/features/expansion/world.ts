import type { Planet } from '../../game/types';
import type { Assignment, ExpansionSettings } from './types';
import type { Route } from './cooperation';
import { distance } from '../../shared/distance';

export interface WorldSnapshot {
  planets: Planet[];
  owned: Planet[];
  allOwned?: Planet[];
  budgets: Map<bigint, number>;
  incoming: Set<bigint>;
}
export interface ExpansionWorld {
  scan(settings: ExpansionSettings, alive: () => boolean): Promise<void>;
  read(): WorldSnapshot;
  quote(source: bigint, target: bigint): { count: number; travelMs: number } | null;
  launch(source: bigint, target: bigint, count: number): Promise<void>;
  route?(source: bigint, target: bigint): Route | null;
  launchGroup?(job: Assignment): Promise<void>;
  dispose(): void;
}
export function nearby(source: Planet, planets: Planet[], locked: Set<bigint>, settings: ExpansionSettings): Planet[] {
  return planets.filter(p => p.ownerId == null && p.planetId !== source.planetId && !locked.has(p.planetId) && distance(source, p) <= settings.radius)
    .sort((a, b) => distance(source, a) - distance(source, b) || (a.planetId < b.planetId ? -1 : 1)).slice(0, settings.candidates);
}
