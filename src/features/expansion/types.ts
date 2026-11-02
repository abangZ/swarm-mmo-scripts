export interface ExpansionSettings { scanMs: number; intervalMs: number; candidates: number; radius: number; horizonMs: number; maxTravelMs: number; reserve: number; maxSources: number;
  economicHorizonMs: number; cautiousExpansion: number; captureSuns: number; captureMeteorites: number; upgradeStable: number; stableMs: number }
export const scanIntervals = [10000, 30000, 60000, 120000] as const;
export const captureMargin = 1;
export const maxCoalitionSources = 10;
export const defaults: ExpansionSettings = { scanMs: 10000, intervalMs: 1500, candidates: 10, radius: 32, horizonMs: 120000, maxTravelMs: 1800000, reserve: 0, maxSources: 3,
  economicHorizonMs: 10800000, cautiousExpansion: 0, captureSuns: 1, captureMeteorites: 1, upgradeStable: 1, stableMs: 600000 };
export function validateSettings(s: ExpansionSettings): void {
  if (!scanIntervals.some(interval => interval === s.scanMs)) throw new Error('扫描间隔请选择 10、30、60 或 120 秒。');
  const ranges: [keyof ExpansionSettings, number, number][] = [['scanMs', 10000, 120000], ['intervalMs', 1000, 2000], ['candidates', 1, 50], ['radius', 1, 128], ['horizonMs', 10000, 600000], ['maxTravelMs', 10000, 14400000], ['reserve', 0, 0xffffffff], ['maxSources', 1, maxCoalitionSources]];
  for (const [key, min, max] of ranges) if (!Number.isSafeInteger(s[key]) || s[key] < min || s[key] > max) throw new Error(`设置 ${key} 应为 ${min}–${max} 范围内的整数。`);
  for (const key of ['cautiousExpansion', 'captureSuns', 'captureMeteorites', 'upgradeStable'] as const) if (s[key] !== 0 && s[key] !== 1) throw new Error(`设置 ${key} 应为开或关。`);
  if (!Number.isSafeInteger(s.economicHorizonMs) || s.economicHorizonMs < 60000 || s.economicHorizonMs > 86400000
    || !Number.isSafeInteger(s.stableMs) || s.stableMs < 60000 || s.stableMs > 86400000) throw new Error('收益周期与稳定时间应为 60–86400 秒。');
}
export interface Contribution { sourceId: bigint; count: number; travelMs: number }
export type TargetKind = 'planet' | 'sun' | 'comet';
export interface Assignment extends Contribution { targetId: bigint; targetKind?: TargetKind; support?: Contribution[]; value?: number; kind?: 'reinforce' | 'sun-supply' | 'upgrade';
  sunId?: bigint; hubBudget?: number; expectedLevel?: number; garrison?: number; expiresAt?: number; reason?: string }
export function targetKey(targetId: bigint, kind: TargetKind = 'planet'): string { return `${kind}:${targetId}`; }
export function jobKey(job: Assignment): string { return targetKey(job.targetId, job.targetKind); }
export function targetLabel(job: Pick<Assignment, 'targetId' | 'targetKind'>): string { return `${job.targetKind === 'sun' ? '恒星' : job.targetKind === 'comet' ? '陨石' : '星球'} #${job.targetId}`; }
export function planetLocks(keys: Iterable<string>): Set<bigint> { return new Set([...keys].filter(key => key.startsWith('planet:')).map(key => BigInt(key.slice(7)))); }
export function members(job: Assignment): Contribution[] { return [job, ...(job.support ?? [])]; }
export function sourceLabel(job: Assignment): string { const sources = members(job); return sources.slice(0, 3).map(m => `#${m.sourceId}`).join(' + ') + (sources.length > 3 ? ` 等 ${sources.length} 颗` : ''); }
export function totalCount(job: Assignment): number { return members(job).reduce((sum, m) => sum + m.count, 0); }
export function completionMs(job: Assignment): number { return Math.max(...members(job).map(m => m.travelMs)); }
export interface Plan { jobs: Assignment[]; exact: boolean }
