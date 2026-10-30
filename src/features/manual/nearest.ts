import type { Planet } from '../../game/types';
import { distance } from '../../shared/distance';
export function nearestUnowned(source: Planet, planets: Iterable<Planet>): Planet | undefined {
  let best: Planet | undefined;
  let bestDistance = Infinity;
  for (const planet of planets) {
    if (planet.planetId === source.planetId || planet.ownerId != null) continue;
    const d = distance(source, planet);
    if (Number.isFinite(d) && (d < bestDistance || (d === bestDistance && (!best || planet.planetId < best.planetId)))) {
      best = planet;
      bestDistance = d;
    }
  }
  return best;
}
export function validateLaunch(source: Planet | undefined, target: Planet | undefined, identity: string, count: number): void {
  if (!source || source.ownerId?.toHexString() !== identity) throw new Error('出发星球已不属于你，请刷新。');
  if (!target || target.ownerId != null || source.planetId === target.planetId) throw new Error('目标已被占领或不可用，请重新搜索。');
  if (!Number.isSafeInteger(count) || count < 1 || count > Math.min(source.probeCount, 0xffffffff)) throw new Error('发送数量必须为正整数，且不能超过已同步库存。');
}
