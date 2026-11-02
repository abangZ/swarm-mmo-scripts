import { defaultPolicy, validatePolicy, type Mode, type Policy } from '../features/commander/types';

export interface PolicyForm { scope: 'all' | 'circle'; x: string; y: string; radius: string; enemy: string; frontlinePercent: string; threatRadius: string; holdProbes: string; rallyId: string; rallyMinutes: string; advanceHub: string }
export interface EnemyOption { id: string; name: string; count: number; x: number; y: number }
export interface HubOption { id: string; x: number; y: number; probes: number }
export interface RegionPreview { busy: boolean; message: string; enemies: EnemyOption[]; hubs?: HubOption[] }
const key = 'swarm-helper-regions-v1';
export const policyForm = (mode: Mode): PolicyForm => ({ scope: mode === 'attack' ? 'circle' : 'all', x: '', y: '', radius: '32', enemy: '', frontlinePercent: String(defaultPolicy.frontlinePercent), threatRadius: String(defaultPolicy.threatRadius), holdProbes: String(defaultPolicy.holdProbes), rallyId: '', rallyMinutes: '30', advanceHub: 'yes' });
export function parsePolicy(form: PolicyForm, mode: Mode): Policy {
  if (form.scope !== 'all' && form.scope !== 'circle') throw new Error('请选择有效的战区范围。');
  if (form.scope === 'circle' && (!form.x.trim() || !form.y.trim() || !form.radius.trim())) throw new Error('请使用地图选取战区中心，或填写坐标与半径。');
  if (!form.frontlinePercent.trim() || !form.threatRadius.trim() || !form.holdProbes.trim()) throw new Error('请填写动态留兵参数。');
  const policy: Policy = { zone: form.scope === 'circle' ? { x: Number(form.x), y: Number(form.y), radius: Number(form.radius) } : null,
    enemy: mode === 'attack' && form.enemy ? form.enemy : null, frontlinePercent: Number(form.frontlinePercent), threatRadius: Number(form.threatRadius), holdProbes: Number(form.holdProbes),
    rallyId: form.rallyId || null, rallyMs: Number(form.rallyMinutes) * 60000, advanceHub: form.advanceHub === 'yes' };
  validatePolicy(policy, mode); return policy;
}
export function loadPolicies(): Record<Mode, PolicyForm> {
  const result = { expansion: policyForm('expansion'), attack: policyForm('attack') };
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
    for (const mode of ['expansion', 'attack'] as const) if (saved?.[mode]) {
      const form = { ...result[mode], ...saved[mode] };
      parsePolicy(form, mode); result[mode] = form;
    }
  } catch { /* Missing or invalid region preferences never arm automation. */ }
  return result;
}
export function savePolicies(forms: Record<Mode, PolicyForm>) { localStorage.setItem(key, JSON.stringify(forms)); }
