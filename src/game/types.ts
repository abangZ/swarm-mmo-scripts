export interface Identity { toHexString(): string }
export interface Planet {
  planetId: bigint;
  ownerId?: Identity | null;
  positionX: number;
  positionY: number;
  probeCount: number;
  galaxyId: bigint;
  level?: number;
  lastUpdateTick?: { toMillis(): number | bigint };
}
export interface Sun extends Omit<Planet, 'planetId'> { sunId: bigint }
export interface Meteorite extends Omit<Planet, 'planetId' | 'level'> { meteoriteId: bigint; expiresAt: { toMillis(): number | bigint } }
export interface SunSwarm { swarmId: bigint; ownerId: Identity; targetSunId: bigint; probeCount?: number; targetBlackHole: boolean; arrivalTime?: { toMillis(): number | bigint } }
export interface Subscription { unsubscribe(): void; isActive(): boolean }
export interface Connection {
  isActive: boolean;
  db: {
    swarm?: Table<Swarm>;
    planet: Table<Planet> & { planetId: { find(id: bigint): Planet | undefined } };
    clan_member2?: Table<{ playerId: Identity; clanId: bigint }>;
    player?: Table<{ identity: Identity; username: string }>;
    player_tech?: Table<{ playerId: Identity }>;
    sun2?: Table<Sun>; base?: Table<unknown>;
    meteorite?: Table<Meteorite>; sun_swarm2?: Table<SunSwarm>;
    attack_automation?: Table<{ sourcePlanetId: bigint }>;
    upgrade_automation?: Table<{ planetId: bigint }>;
  };
  reducers: { launchSwarmBulk?(args: { kind: number; targetId: bigint; launches: { sourceId: bigint; probeCount: number }[] }): Promise<void>; launchSwarm(args: { sourcePlanetId: bigint; targetPlanetId: bigint; probeCount: number }): Promise<void>;
    launchSwarmAtSun?(args: { sourcePlanetId: bigint; targetSunId: bigint; probeCount: number }): Promise<void>;
    launchSwarmAtMeteorite?(args: { sourcePlanetId: bigint; targetMeteoriteId: bigint; probeCount: number }): Promise<void>;
    upgradePlanet?(args: { planetId: bigint }): Promise<void> };
  subscriptionBuilder(): {
    onApplied(fn: () => void): ReturnType<Connection['subscriptionBuilder']>;
    onError(fn: () => void): ReturnType<Connection['subscriptionBuilder']>;
    subscribe(query: string): Subscription;
  };
}
export interface Session { conn: Connection; identity: string }
export interface Table<T> { iter(): Iterable<T> }
export interface Swarm {
  swarmId: bigint; ownerId: Identity; targetPlanetId: bigint;
  targetSunId?: bigint; targetMeteoriteId?: bigint;
  probeCount?: number; sourceX?: number; sourceY?: number;
  arrivalTime?: { toMillis(): number | bigint };
}

export interface Quote { travelMs: number; lossPct: number; outOfRange: boolean; exact?: { reason: string; probes: number } }
export interface MapController {
  quoteSend(sourceKind: 'planet', source: bigint, targetKind: 'planet' | 'sun' | 'comet', target: bigint): Quote | null;
  listOwnedBodies(): { kind: string; id: bigint; probes: number }[];
  getPickedBody?(): { id: bigint; isSun: boolean; x: number; y: number } | null;
  getViewCenter?(): { x: number; y: number };
  focusPlanet?(x: number, y: number): void;
}
export interface AutomationSession extends Session { map: MapController }
