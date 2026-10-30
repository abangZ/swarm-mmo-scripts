export interface Identity { toHexString(): string }
export interface Planet {
  planetId: bigint;
  ownerId?: Identity | null;
  positionX: number;
  positionY: number;
  probeCount: number;
  galaxyId: bigint;
}
export interface Subscription { unsubscribe(): void; isActive(): boolean }
export interface Connection {
  isActive: boolean;
  db: { swarm?: { iter(): Iterable<Swarm> }; planet: { iter(): Iterable<Planet>; planetId: { find(id: bigint): Planet | undefined } } };
  reducers: { launchSwarmBulk?(args: { kind: number; targetId: bigint; launches: { sourceId: bigint; probeCount: number }[] }): Promise<void>; launchSwarm(args: { sourcePlanetId: bigint; targetPlanetId: bigint; probeCount: number }): Promise<void> };
  subscriptionBuilder(): {
    onApplied(fn: () => void): ReturnType<Connection['subscriptionBuilder']>;
    onError(fn: () => void): ReturnType<Connection['subscriptionBuilder']>;
    subscribe(query: string): Subscription;
  };
}
export interface Session { conn: Connection; identity: string }
export interface Swarm { swarmId: bigint; ownerId: Identity; targetPlanetId: bigint }

export interface Quote { travelMs: number; lossPct: number; outOfRange: boolean; exact?: { reason: string; probes: number } }
export interface MapController {
  quoteSend(sourceKind: 'planet', source: bigint, targetKind: 'planet', target: bigint): Quote | null;
  listOwnedBodies(): { kind: string; id: bigint; probes: number }[];
}
export interface AutomationSession extends Session { map: MapController }
