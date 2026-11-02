import { maxCoalitionSources, scanIntervals, type ExpansionSettings as Settings } from '../features/expansion/types';
import type { SettingsForm } from '../app/settings';

interface Props {
  value: SettingsForm;
  disabled: boolean;
  onChange(key: keyof Settings, value: string): void;
  attack?: boolean;
}
const numericFields = [
  { key: 'candidates', label: '每颗星球的候选数 n（1–50）', min: 1, max: 50, step: 1 },
  { key: 'radius', label: '最大搜索距离（1–128）', min: 1, max: 128, step: 1 },
  { key: 'intervalMs', label: '操作间隔（秒，1–2）', min: 1, max: 2, step: 0.1 },
  { key: 'horizonMs', label: '向未来规划多久（秒，非扫描间隔）', min: 10, max: 600, step: 1 },
  { key: 'reserve', label: '每颗星球留守探针', min: 0, max: 0xffffffff, step: 1 },
] as const;

export function ExpansionSettings({ value, disabled, onChange, attack = false }: Props) {
  const id = (key: string) => attack ? `attack-${key}` : key;
  return <>
    <label htmlFor={id('scanMs')}>每隔多久扫描一次</label>
    <select id={id('scanMs')} disabled={disabled} value={value.scanMs} onChange={event => onChange('scanMs', event.target.value)}>
      {scanIntervals.map(ms => <option key={ms} value={ms / 1000}>{ms / 1000} 秒</option>)}
    </select>
    {numericFields.filter(field => !attack || field.key !== 'intervalMs').map(({ key, label, ...bounds }) => <div key={key}>
      <label htmlFor={id(key)}>{key === 'horizonMs' ? '规划队列窗口（秒，不限制航行时间）' : label}</label>
      <input id={id(key)} type="number" {...bounds} disabled={disabled} value={value[key]} onChange={event => onChange(key, event.target.value)} />
    </div>)}
    {attack && <p>进攻操作间隔固定为 1 秒，使用独立队列；等待本模式发射确认和库存同步后再执行下一项。</p>}
    <>
      <label htmlFor={id("maxTravelMs")}>{attack ? "进攻最长航行时间（秒，默认 1800＝30 分钟）" : "最长航行时间（秒，默认 1800＝30 分钟）"}</label>
      <input id={id("maxTravelMs")} type="number" min={10} max={14400} step={1} disabled={disabled} value={value.maxTravelMs} onChange={event => onChange('maxTravelMs', event.target.value)} />
      <p>规划 120 秒表示安排近期要发出的队列，不要求两分钟内抵达。近程先发，后方来源也可执行较远任务；搜索距离与固定区域仍生效。</p>
    </>
    {!attack && <><label htmlFor="maxSources">每个目标最多协同星球数（1–{maxCoalitionSources}）</label>
    <input id="maxSources" type="number" min={1} max={maxCoalitionSources} step={1} disabled={disabled} value={value.maxSources} onChange={event => onChange('maxSources', event.target.value)} />
    <p>默认 3 颗，填 1 表示仅单星。优先用更少来源完成占领，不会为了凑够设置数量而拆兵。</p>
    <p>协同来源彼此距离不超过 8，预计抵达时间相差不超过 15 秒。一次批量派兵，计一次扩张队列操作。</p></>}
    <p>两个模式使用独立队列和操作间隔，共享兵力预算；覆盖扫描采用较快的周期。</p>
  </>;
}
