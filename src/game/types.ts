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
export interface Subscription { unsubscribe(): void; isActive(): boolean }
export interface Connection {
  isActive: boolean;
  db: {
    swarm?: Table<Swarm>;
    planet: Table<Planet> & { planetId: { find(id: bigint): Planet | undefined } };
    clan_member2?: Table<{ playerId: Identity; clanId: bigint }>;
    player?: Table<{ identity: Identity; username: string }>;
    player_tech?: Table<{ playerId: Identity }>;
    sun2?: Table<unknown>; base?: Table<unknown>;
    attack_automation?: Table<{ sourcePlanetId: bigint }>;
    upgrade_automation?: Table<{ planetId: bigint }>;
  };
  reducers: { launchSwarmBulk?(args: { kind: number; targetId: bigint; launches: { sourceId: bigint; probeCount: number }[] }): Promise<void>; launchSwarm(args: { sourcePlanetId: bigint; targetPlanetId: bigint; probeCount: number }): Promise<void> };
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
  probeCount?: number; sourceX?: number; sourceY?: number;
  arrivalTime?: { toMillis(): number | bigint };
}

export interface Quote { travelMs: number; lossPct: number; outOfRange: boolean; exact?: { reason: string; probes: number } }
export interface MapController {
  quoteSend(sourceKind: 'planet', source: bigint, targetKind: 'planet', target: bigint): Quote | null;
  listOwnedBodies(): { kind: string; id: bigint; probes: number }[];
  getPickedBody?(): { id: bigint; isSun: boolean; x: number; y: number } | null;
  getViewCenter?(): { x: number; y: number };
  focusPlanet?(x: number, y: number): void;
}
export interface AutomationSession extends Session { map: MapController }
