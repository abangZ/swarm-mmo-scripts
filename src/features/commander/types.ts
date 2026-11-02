import type { ExpansionSettings } from '../expansion/types';
import type { Planet } from '../../game/types';

export type Mode = 'expansion' | 'attack';
export interface Zone { x: number; y: number; radius: number }
export interface Policy {
  zone: Zone | null;
  enemy: string | null;
  frontlinePercent: number;
  threatRadius: number;
  holdProbes: number;
  rallyId: string | null;
  rallyMs: number;
  advanceHub: boolean;
  rallyHubs: number;
}
export interface ModeConfig { settings: ExpansionSettings; policy: Policy }
export const defaultPolicy: Policy = { zone: null, enemy: null, frontlinePercent: 25, threatRadius: 16, holdProbes: 10, rallyId: null, rallyMs: 1800000, advanceHub: true, rallyHubs: 3 };
export function inZone(p: Pick<Planet, 'positionX' | 'positionY'>, zone: Zone | null): boolean {
  return !zone || Math.hypot(p.positionX - zone.x, p.positionY - zone.y) <= zone.radius;
}
export function validatePolicy(policy: Policy, mode: Mode): void {
  if (mode === 'attack' && !policy.zone) throw new Error('请先选取进攻战区。');
  if (policy.zone && (!Number.isSafeInteger(policy.zone.x) || !Number.isSafeInteger(policy.zone.y) || Math.abs(policy.zone.x) > 2147483000 || Math.abs(policy.zone.y) > 2147483000 || !Number.isSafeInteger(policy.zone.radius) || policy.zone.radius < 1 || policy.zone.radius > 128)) throw new Error('战区坐标应为整数，半径为 1–128。');
  if (policy.enemy !== null && !/^[0-9a-f]{64}$/i.test(policy.enemy)) throw new Error('请选择有效的敌人。');
  if (!Number.isInteger(policy.rallyHubs) || policy.rallyHubs < 1 || policy.rallyHubs > 3) throw new Error('同时集结据点数应为 1–3。');
  if (policy.rallyId !== null && (!/^[1-9][0-9]{0,19}$/.test(policy.rallyId) || BigInt(policy.rallyId) > 18446744073709551615n)) throw new Error('请选择有效的中转星。');
  if (!Number.isSafeInteger(policy.rallyMs) || policy.rallyMs < 60000 || policy.rallyMs > 14400000 || typeof policy.advanceHub !== 'boolean') throw new Error('集结航行上限应为 1–240 分钟。');
  for (const [value, min, max] of [[policy.frontlinePercent, 0, 90], [policy.threatRadius, 1, 128], [policy.holdProbes, 2, 1000000]]) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('动态留兵参数超出有效范围。');
  }
}
