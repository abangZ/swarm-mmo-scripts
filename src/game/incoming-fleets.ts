import type { Connection, Subscription } from './types';

export interface FleetTotal { probes: string; fleets: number; unknown: number }
export type IncomingTotals = Record<'mine' | 'enemy' | 'ally', FleetTotal>;
export type IncomingState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; totals: IncomingTotals };

export function totalIncoming(conn: Connection, identity: string, planetId: bigint): IncomingTotals {
  if (!conn.db.swarm || !conn.db.clan_member2) throw new Error('舰队情报接口不可用');
  const clans = [...conn.db.clan_member2.iter()];
  const clan = clans.find(c => c.playerId.toHexString() === identity)?.clanId;
  const allies = new Set(clans.filter(c => clan !== undefined && c.clanId === clan).map(c => c.playerId.toHexString()));
  const totals = { mine: { count: 0n, fleets: 0, unknown: 0 }, enemy: { count: 0n, fleets: 0, unknown: 0 }, ally: { count: 0n, fleets: 0, unknown: 0 } };
  const seen = new Set<bigint>();
  for (const fleet of conn.db.swarm.iter()) {
    if (fleet.targetPlanetId !== planetId || seen.has(fleet.swarmId)) continue;
    seen.add(fleet.swarmId);
    const owner = fleet.ownerId.toHexString();
    const group = totals[owner === identity ? 'mine' : allies.has(owner) ? 'ally' : 'enemy'];
    group.fleets++;
    if (Number.isSafeInteger(fleet.probeCount) && fleet.probeCount! >= 0) group.count += BigInt(fleet.probeCount!);
    else group.unknown++;
  }
  const result = (t: typeof totals.mine): FleetTotal => ({ probes: String(t.count), fleets: t.fleets, unknown: t.unknown });
  return { mine: result(totals.mine), enemy: result(totals.enemy), ally: result(totals.ally) };
}

/** Owns only this inspector's handles, including subscriptions awaiting application. */
export function watchIncoming(conn: Connection, identity: string, planetId: bigint): { read(): IncomingState; dispose(): void } {
  const handles: Subscription[] = [];
  let disposed = false, failed = false, applied = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    clearTimeout(timeout);
    for (const handle of handles.splice(0)) { try { handle.unsubscribe(); } catch { /* disconnected */ } }
  };
  const fail = () => { if (!disposed) { failed = true; release(); } };
  timeout = setTimeout(fail, 12000);
  try {
    if (!conn.db.swarm || !conn.db.clan_member2 || planetId <= 0n || planetId > 0xffffffffffffffffn) throw new Error('接口不可用');
    for (const query of [`SELECT * FROM swarm WHERE target_planet_id = ${planetId}`, 'SELECT * FROM clan_member2']) {
      let acknowledged = false;
      const handle = conn.subscriptionBuilder().onApplied(() => {
        if (disposed || failed || acknowledged) return;
        acknowledged = true;
        if (++applied === 2) clearTimeout(timeout);
      }).onError(fail).subscribe(query);
      if (failed || disposed) { handle.unsubscribe(); break; }
      handles.push(handle);
    }
  } catch { fail(); }
  return {
    read() {
      if (disposed || failed) return { status: 'error' };
      if (!conn.isActive) { fail(); return { status: 'error' }; }
      if (applied < 2) return { status: 'loading' };
      if (handles.some(h => !h.isActive())) { fail(); return { status: 'error' }; }
      try { return { status: 'ready', totals: totalIncoming(conn, identity, planetId) }; }
      catch { fail(); return { status: 'error' }; }
    },
    dispose() { disposed = true; release(); },
  };
}
