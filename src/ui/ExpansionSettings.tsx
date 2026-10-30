import { scanIntervals, type ExpansionSettings as Settings } from '../features/expansion/types';
import type { SettingsForm } from '../app/settings';

interface Props {
  value: SettingsForm;
  disabled: boolean;
  onChange(key: keyof Settings, value: string): void;
}
const numericFields = [
  { key: 'candidates', label: '每颗星球的候选数 n（1–50）', min: 1, max: 50, step: 1 },
  { key: 'radius', label: '最大搜索距离（1–128）', min: 1, max: 128, step: 1 },
  { key: 'intervalMs', label: '操作间隔（秒，1–2）', min: 1, max: 2, step: 0.1 },
  { key: 'horizonMs', label: '向未来规划多久（秒，非扫描间隔）', min: 10, max: 600, step: 1 },
  { key: 'reserve', label: '每颗星球留守探针', min: 0, max: 0xffffffff, step: 1 },
] as const;

export function ExpansionSettings({ value, disabled, onChange }: Props) {
  return <>
    <label htmlFor="scanMs">每隔多久扫描一次</label>
    <select id="scanMs" disabled={disabled} value={value.scanMs} onChange={event => onChange('scanMs', event.target.value)}>
      {scanIntervals.map(ms => <option key={ms} value={ms / 1000}>{ms / 1000} 秒</option>)}
    </select>
    {numericFields.map(({ key, label, ...bounds }) => <div key={key}>
      <label htmlFor={key}>{label}</label>
      <input id={key} type="number" {...bounds} disabled={disabled} value={value[key]} onChange={event => onChange(key, event.target.value)} />
    </div>)}
    <label htmlFor="maxSources">每个目标最多协同星球数</label>
    <select id="maxSources" disabled={disabled} value={value.maxSources} onChange={event => onChange('maxSources', event.target.value)}>
      <option value="1">1 颗（仅单星）</option><option value="2">2 颗</option><option value="3">3 颗</option>
    </select>
    <p>协同来源彼此距离不超过 8，预计抵达时间相差不超过 15 秒。一次批量派兵，共用操作限速。</p>
  </>;
}
