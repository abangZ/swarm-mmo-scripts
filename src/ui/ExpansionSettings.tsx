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
  { key: 'intervalMs', label: '操作基准间隔（秒，1–2，随机 ±0.2 秒）', min: 1, max: 2, step: 0.1 },
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
    {!attack && <p>设为 1.2 秒时，每次间隔随机为 1.0～1.4 秒，最短 1 秒。不等待发射回执；超时跳过并继续，库存后台同步。</p>}
    <>
      <label htmlFor={id("maxTravelMs")}>{attack ? "进攻最长航行时间（秒，默认 1800＝30 分钟）" : "最长航行时间（秒，默认 1800＝30 分钟）"}</label>
      <input id={id("maxTravelMs")} type="number" min={10} max={14400} step={1} disabled={disabled} value={value.maxTravelMs} onChange={event => onChange('maxTravelMs', event.target.value)} />
      <p>规划 120 秒表示安排近期要发出的队列，不要求两分钟内抵达。近程先发，后方来源也可执行较远任务；搜索距离与固定区域仍生效。</p>
    </>
    {!attack && <><label htmlFor="maxSources">每个目标最多协同星球数（1–{maxCoalitionSources}）</label>
    <input id="maxSources" type="number" min={1} max={maxCoalitionSources} step={1} disabled={disabled} value={value.maxSources} onChange={event => onChange('maxSources', event.target.value)} />
    <p>默认 3 颗，填 1 表示仅单星。优先用更少来源完成占领，不会为了凑够设置数量而拆兵。</p>
    <p>协同来源彼此距离不超过 8，预计抵达时间相差不超过 15 秒。一次批量派兵，计一次扩张队列操作。</p></>}
    {!attack && <>
      <label htmlFor="cautiousExpansion">扩张取向</label>
      <select id="cautiousExpansion" disabled={disabled} value={value.cautiousExpansion} onChange={event => onChange('cautiousExpansion', event.target.value)}>
        <option value="0">快速铺开：优先占更多点</option><option value="1">稳健扩张：暂缓孤立高风险点</option>
      </select>
      <p>默认持续派兵，不等待整波落地。两种取向均保留来源守军和已知来袭预算；风险按已观测邻敌与支援距离判断。</p>
      {([{ key: 'captureSuns', label: '尽早占领附近无主恒星' }, { key: 'captureMeteorites', label: '占领能及时抵达的无主陨石' },
        { key: 'upgradeStable', label: '稳定后方按需逐级升级' }] as const).map(({ key, label }) => <label className="strategy-toggle" key={key} htmlFor={key}>
        <input id={key} type="checkbox" disabled={disabled} checked={value[key] === '1'} onChange={event => onChange(key, event.target.checked ? '1' : '0')} />{label}
      </label>)}
      <p>每轮优先安排一颗可占恒星。碎片兵力先汇到己方星球，实际到账后发射；不长期攒兵。陨石无产量，持有至到期才获得奖励，到期时驻军也消失。</p>
      <label htmlFor="economicHorizonMs">收益评估周期（秒，默认 10800＝3 小时）</label>
      <input id="economicHorizonMs" type="number" min={60} max={86400} step={60} disabled={disabled} value={value.economicHorizonMs} onChange={event => onChange('economicHorizonMs', event.target.value)} />
      <label htmlFor="stableMs">升级前连续稳定时间（秒，默认 600＝10 分钟）</label>
      <input id="stableMs" type="number" min={60} max={86400} step={60} disabled={disabled} value={value.stableMs} onChange={event => onChange('stableMs', event.target.value)} />
      <p>升级只使用稳定、无邻敌、无来袭、无附近无主目标且未参与任务的后方来源；每次升一级，基础回本时间须在收益周期内。刷新或断线后重新观察稳定时间。</p>
    </>}
    <p>两个模式使用独立队列和操作间隔，共享兵力预算；覆盖扫描采用较快的周期。</p>
  </>;
}
