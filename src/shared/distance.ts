import type { Planet } from '../game/types';
export function distance(a: Planet, b: Planet): number {
  return Math.hypot(a.positionX - b.positionX, a.positionY - b.positionY);
}
