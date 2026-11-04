import type { Planet, Sun, Meteorite } from '../../game/types';
import { targetKey, type Assignment, type ExpansionSettings, type TargetKind } from './types';
import type { Route } from './cooperation';
import { distance } from '../../shared/distance';
import type { ModeConfig } from '../commander/types';

export interface Fleet {
  id: bigint; owner: string; target: bigint; source?: bigint; count: number | null; arrival: number | null;
  // Only populated when the adapter can establish an arrival lower bound.
  arriving: number | null;
}

export interface WorldSnapshot {
  // Adapter-owned fingerprint of native quote rules: identity, technology,
  // alliances, bases and sun coverage. Absent means cross-round reuse is unsafe.
  quoteVersion?: string;
  // Native neutral capture/route dependencies, partitioned by source influence.
  // Adapters without these retain the conservative whole-world version.
  quoteGlobalVersion?: string;
  sourceQuoteVersions?: Map<bigint, string>;
  productionTicks?: Map<bigint, number>;
  // Optimistic combat multiplier without requiring source coverage. Used only
  // to reject impossible neutral captures, never to price or dispatch a fleet.
  attackMultiplierUpperBound?: number;
  planets: Planet[];
  owned: Planet[];
  allOwned?: Planet[];
  budgets: Map<bigint, number>;
  incoming: Set<bigint>;
  identity?: string;
  allies?: Set<string>;
  fleets?: Fleet[];
  fleetsByTarget?: Map<bigint, Fleet[]>;
  automated?: Set<bigint>;
  intelligence?: boolean;
  players?: Map<string, string>;
  suns?: Sun[];
  meteorites?: Meteorite[];
  bodyFleets?: Map<string, Fleet[]>;
}
export function bodyFleetsFor(snapshot: WorldSnapshot, id: bigint, kind: TargetKind = 'planet'): Fleet[] {
  return kind === 'planet' ? fleetsFor(snapshot, id) : snapshot.bodyFleets?.get(targetKey(id, kind)) ?? [];
}
export function bodyFor(snapshot: WorldSnapshot, id: bigint, kind: TargetKind = 'planet') {
  return kind === 'sun' ? snapshot.suns?.find(p => p.sunId === id) : kind === 'comet' ? snapshot.meteorites?.find(p => p.meteoriteId === id) : snapshot.planets.find(p => p.planetId === id);
}
export function fleetsFor(snapshot: WorldSnapshot, target: bigint): Fleet[] {
  return snapshot.fleetsByTarget?.get(target) ?? (snapshot.fleetsByTarget ? [] : snapshot.fleets?.filter(f => f.target === target) ?? []);
}
export interface WorldDiagnostics { readTotalMs?: number; readCalls?: number; ownedBodiesMs?: number; quoteMaxMs?: number; slowQuotes?: number; syncCalls?: number; syncQueries?: number; syncTotalMs?: number; syncActive?: number; readMs: number; scanMs: number; syncMs: number; quoteMs: number; quoteCalls: number; newSubscriptions: number; reusedSubscriptions: number }
export interface ExpansionWorld {
  diagnostics?(): WorldDiagnostics;
  scan(settings: ExpansionSettings, alive: () => boolean): Promise<void>;
  configure?(configs: ModeConfig[]): void;
  needsScan?(): boolean;
  refreshQuotes?(): void;
  read(): WorldSnapshot;
  quote(source: bigint, target: bigint): { count: number; travelMs: number } | null;
  launch(source: bigint, target: bigint, count: number): Promise<void>;
  route?(source: bigint, target: bigint): Route | null;
  launchGroup?(job: Assignment): Promise<void>;
  supportsGroup?(): boolean;
  quoteBody?(source: bigint, target: bigint, kind: 'sun' | 'comet'): { count: number; travelMs: number } | null;
  bodyQuoteIssue?(source: bigint, target: bigint, kind: 'sun' | 'comet'): string | undefined;
  routeBody?(source: bigint, target: bigint, kind: 'sun' | 'comet'): Route | null;
  launchBody?(job: Assignment): Promise<void>;
  upgradeMany?(planetIds: bigint[]): Promise<void>;
  upgrade?(planetId: bigint): Promise<void>;
  syncInventory?(sources: bigint[]): Promise<void>;
  dispose(): void;
}
export function nearby(source: Planet, planets: Planet[], locked: Set<bigint>, settings: ExpansionSettings): Planet[] {
  return planets.filter(p => p.ownerId == null && p.planetId !== source.planetId && !locked.has(p.planetId) && distance(source, p) <= settings.radius)
    .sort((a, b) => distance(source, a) - distance(source, b) || (a.planetId < b.planetId ? -1 : 1)).slice(0, settings.candidates);
}
