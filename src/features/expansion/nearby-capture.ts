import type { Planet } from '../../game/types';
import { bestCandidates } from '../../shared/best-candidates';
import { distance } from '../../shared/distance';
import { validRoute, type Route } from './cooperation';
import { captureMargin, type ExpansionSettings } from './types';
import { fleetsFor, type WorldSnapshot } from './world';

interface Prospect { target: bigint; required: number; eta: number }

/** Draft-local forecasts only. A forecast can defer spending, never create a launch. */
export function nearbyCaptureWindow(snapshot: WorldSnapshot, settings: ExpansionSettings,
  neighbors: (source: Planet, radius: number) => Planet[], eligible: (target: Planet) => boolean,
  price: (source: Planet, target: Planet) => { route?: Route | null; count?: number }, protectReady = false) {
  const cache = new Map<bigint, { stock: number; prospects: Prospect[] }>();
  return (source: Planet, stock: number, spend: number, eta: number, destination?: bigint, locked?: Set<bigint>) => {
    const tick = snapshot.productionTicks?.get(source.planetId), level = source.level;
    if (!tick || !Number.isFinite(tick) || tick <= 0 || !Number.isInteger(level) || !level || level < 1 || level > 10 || !stock || !spend) return;
    // Short trips do not need another search for a future production tick.
    if (eta <= tick) return;
    let entry = cache.get(source.planetId);
    if (!entry || entry.stock !== stock) {
      const radius = Math.min(settings.radius, 8);
      const local = neighbors(source, radius).filter(p => p.ownerId == null && Number.isSafeInteger(p.probeCount)
        && p.probeCount >= 0 && p.probeCount < Math.ceil((stock + 2) * (snapshot.attackMultiplierUpperBound ?? 2))
        && !snapshot.incoming.has(p.planetId) && !fleetsFor(snapshot, p.planetId).length && eligible(p));
      const prospects: Prospect[] = [];
      for (const target of bestCandidates(local, 4, p => distance(source, p))) {
        const { route, count } = price(source, target);
        if (!validRoute(route) || route.travelMs > settings.maxTravelMs) continue;
        const required = count ?? Math.ceil((target.probeCount + captureMargin) * 100 / (100 - route.lossPct));
        const gap = required - stock;
        // If the estimate says it is already affordable, require the actual native price.
        if (!Number.isSafeInteger(required) || gap > 2 || (gap <= 0 && (!protectReady || count === undefined))) continue;
        prospects.push({ target: target.planetId, required, eta: Math.ceil(Math.max(0, gap) / level) * tick + route.travelMs });
      }
      entry = { stock, prospects: prospects.sort((a, b) => a.eta - b.eta) };
      cache.set(source.planetId, entry);
    }
    return entry.prospects.find(p => p.target !== destination && !locked?.has(p.target) && stock - spend < p.required && p.eta < eta);
  };
}
