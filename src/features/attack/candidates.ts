import type { Planet } from '../../game/types';
import { bestCandidates } from '../../shared/best-candidates';

/** Preserve near and economical options, and backfill after route validation. */
export function attackCandidates(source: Planet, nearby: Planet[], limit: number): Planet[] {
  const orders = [
    bestCandidates(nearby, limit, p => (p.positionX - source.positionX) ** 2 + (p.positionY - source.positionY) ** 2),
    bestCandidates(nearby, limit, p => -(p.level ?? 1) / (p.probeCount + 1)),
  ];
  const picked = new Map<bigint, Planet>();
  for (let i = 0; picked.size < limit && i < nearby.length; i++) for (const order of orders) {
    if (order[i] && picked.size < limit) picked.set(order[i].planetId, order[i]);
  }
  return [...picked.values()];
}
