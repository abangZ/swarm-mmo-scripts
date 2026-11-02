import type { Planet } from '../game/types';
export function distance(a: Pick<Planet, 'positionX' | 'positionY'>, b: Pick<Planet, 'positionX' | 'positionY'>): number {
  return Math.hypot(a.positionX - b.positionX, a.positionY - b.positionY);
}
