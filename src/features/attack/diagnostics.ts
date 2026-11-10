import type { ModeConfig } from '../commander/types';
import { inZone } from '../commander/types';
import type { WorldSnapshot } from '../expansion/world';

export interface AttackDiagnostics {
  sources: number; available: number; targets: number; blocked: number;
  noBudget: number; noTargets: number; tooSlow: number; noQuote: number; insufficient: number; feasible: number;
}
/** Run against fresh scan coverage, never against a saved preview. */
export function attackStartupIssue(snapshot: WorldSnapshot, config: ModeConfig): string | undefined {
  const owned = snapshot.owned.filter(p => inZone(p, config.policy.zone));
  if (!owned.length) {
    const zone = config.policy.zone!;
    const nearest = [...(snapshot.allOwned ?? snapshot.owned)].sort((a, b) =>
      Math.hypot(a.positionX - zone.x, a.positionY - zone.y) - Math.hypot(b.positionX - zone.x, b.positionY - zone.y))[0];
    return `进攻未启动：战区内己方星球为 0。请把战区移到敌我交界，并同时覆盖兵源和目标。${nearest ? `最近己方星 #${nearest.planetId} (${nearest.positionX}, ${nearest.positionY}) 距中心 ${Math.ceil(Math.hypot(nearest.positionX - zone.x, nearest.positionY - zone.y))} 格，当前半径 ${zone.radius}。` : ''}`;
  }
  if (owned.every(p => snapshot.automated?.has(p.planetId))) return `进攻未启动：战区内 ${owned.length} 颗己方星均启用了原生自动转发，没有可调度兵源。`;
}
