import { maxCoalitionSources, scanIntervals, type ExpansionSettings as Settings } from '../features/expansion/types';
import type { SettingsForm } from '../app/settings';
import { SettingHeading } from './SettingHeading';

interface Props {
  value: SettingsForm;
  disabled: boolean;
  onChange(key: keyof Settings, value: string): void;
  attack?: boolean;
}
const numericFields = [
  { key: 'candidates', label: '每颗星球的候选数（1–50）', min: 1, max: 50, step: 1,
    help: '每颗来源参与比较的候选目标数量。数量越多，评估工作越多；附近可打目标优先。' },
  { key: 'radius', label: '最大搜索距离（1–128）', min: 1, max: 128, step: 1,
    help: '限制附近目标的搜索范围；设置了固定战区时，来源与目标还必须位于战区内。' },
  { key: 'intervalMs', label: '操作基准间隔（秒）', min: 1, max: 2, step: 0.1,
    help: '可设 1～2 秒，随机 ±0.2 秒，最短 1 秒。例如 1.2 秒对应 1.0～1.4 秒。不等待发射回执；超时跳过并继续，库存后台同步。' },
  { key: 'horizonMs', label: '规划队列窗口（秒）', min: 10, max: 600, step: 1,
    help: '限制预计排队时间，不是扫描间隔或航行截止时间。例如 120 秒表示安排近期要发出的队列，不要求两分钟内抵达。' },
  { key: 'reserve', label: '每颗星球留守探针', min: 0, max: 0xffffffff, step: 1,
    help: '每颗来源至少保留的探针数。前线留兵和已知来袭可能要求更多守军；两个模式共享库存与防守预算。' },
] as const;
const toggles = [
  { key: 'captureSuns', label: '尽早占领附近无主恒星',
    help: '优先安排可占恒星。兵力不足时，后方分批补给己方中转星，计划持续更新，实际到账后再出击。' },
  { key: 'captureMeteorites', label: '占领能及时抵达的无主陨石',
    help: '只安排能在消失前抵达的目标。陨石无产量，持有至到期才获得奖励，到期时驻军也消失。' },
  { key: 'upgradeStable', label: '按收益与占领时间升级',
    help: '后方稳定且无附近无主机会时按回本升级；前线仅在先升 1→2 级预计更早占领时升级，计入补给与升级成本。均需稳定、无邻敌、无来袭，回本在收益周期内。每批最多 200 颗，每颗只升一级。' },
] as const;

export function ExpansionSettings({ value, disabled, onChange, attack = false }: Props) {
  const id = (key: string) => attack ? `attack-${key}` : key;
  return <>
    <SettingHeading htmlFor={id('scanMs')} label="扫描间隔" help="从本轮规划完成后开始计时，不等操作队列执行完。两个模式同时运行时，覆盖扫描采用较快的周期；操作队列和限速各自独立。" />
    <select id={id('scanMs')} disabled={disabled} value={value.scanMs} onChange={event => onChange('scanMs', event.target.value)}>
      {scanIntervals.map(ms => <option key={ms} value={ms / 1000}>{ms / 1000} 秒</option>)}
    </select>
    {numericFields.filter(field => !attack || field.key !== 'intervalMs').map(({ key, label, help, ...bounds }) => <div key={key}>
      <SettingHeading htmlFor={id(key)} label={label} help={help} />
      <input id={id(key)} type="number" {...bounds} disabled={disabled} value={value[key]} onChange={event => onChange(key, event.target.value)} />
    </div>)}
    {attack && <SettingHeading label="操作间隔：1 秒" help="进攻操作间隔固定为 1 秒，使用独立队列；等待本模式发射确认和库存同步后再执行下一项。" />}
    <SettingHeading htmlFor={id('maxTravelMs')} label="最长航行时间（秒）" help="默认 1800 秒（30 分钟），独立限制单次航程。近程先发，后方来源也可执行较远任务；搜索距离与固定战区仍生效。" />
    <input id={id('maxTravelMs')} type="number" min={10} max={14400} step={1} disabled={disabled} value={value.maxTravelMs} onChange={event => onChange('maxTravelMs', event.target.value)} />
    {!attack && <>
      <SettingHeading htmlFor="maxSources" label={`直接合兵最多协同星球数（1–${maxCoalitionSources}）`} help="默认 3 颗，填 1 表示仅单星直攻。优先用更少来源完成占领，不为凑数量而拆兵。协同来源彼此距离不超过 8，抵达时差不超过 15 秒；一次批量派兵计一个操作。后方补给不受此数量限制，每批最多 50 颗。" />
      <input id="maxSources" type="number" min={1} max={maxCoalitionSources} step={1} disabled={disabled} value={value.maxSources} onChange={event => onChange('maxSources', event.target.value)} />
      <SettingHeading htmlFor="cautiousExpansion" label="扩张取向" help="默认持续派兵，不等待整波落地。两种取向均保留守军和已知来袭预算；风险按已观测邻敌与支援距离判断。" />
      <select id="cautiousExpansion" disabled={disabled} value={value.cautiousExpansion} onChange={event => onChange('cautiousExpansion', event.target.value)}>
        <option value="0">快速铺开：优先占更多点</option><option value="1">稳健扩张：暂缓孤立高风险点</option>
      </select>
      {toggles.map(({ key, label, help }) => <SettingHeading key={key} label={label} help={help}>
        <label className="strategy-toggle" htmlFor={key}>
          <input id={key} type="checkbox" disabled={disabled} checked={value[key] === '1'} onChange={event => onChange(key, event.target.checked ? '1' : '0')} />{label}
        </label>
      </SettingHeading>)}
      <SettingHeading htmlFor="economicHorizonMs" label="收益评估周期（秒）" help="默认 10800 秒（3 小时）。用于评估占领收益与升级回本，独立于规划队列窗口；升级回本须在此周期内。" />
      <input id="economicHorizonMs" type="number" min={60} max={86400} step={60} disabled={disabled} value={value.economicHorizonMs} onChange={event => onChange('economicHorizonMs', event.target.value)} />
      <SettingHeading htmlFor="stableMs" label="升级前连续稳定时间（秒）" help="默认 600 秒（10 分钟）。符合安全条件并连续观察满此时间后才考虑升级；刷新、重启或断线恢复后重新观察。" />
      <input id="stableMs" type="number" min={60} max={86400} step={60} disabled={disabled} value={value.stableMs} onChange={event => onChange('stableMs', event.target.value)} />
    </>}
  </>;
}
