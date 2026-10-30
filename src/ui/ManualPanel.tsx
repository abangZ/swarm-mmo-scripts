import type { Planet } from '../game/types';

interface Props {
  planets: Planet[];
  sourceId: string;
  count: string;
  target: string;
  status: string;
  disabled: boolean;
  canSend: boolean;
  onSourceChange(value: string): void;
  onCountChange(value: string): void;
  onRefresh(): void;
  onSearch(): void;
  onSend(): void;
}
export function ManualPanel(props: Props) {
  return <>
    <label htmlFor="source">出发星球</label>
    <select id="source" value={props.sourceId} disabled={props.disabled} onChange={event => props.onSourceChange(event.target.value)}>
      {!props.planets.length && <option value="">请刷新星球列表</option>}
      {props.planets.map(planet => <option key={String(planet.planetId)} value={String(planet.planetId)}>
        #{String(planet.planetId)} · ({planet.positionX}, {planet.positionY}) · {planet.probeCount} 探针
      </option>)}
    </select>
    <div className="row">
      <button id="refresh" disabled={props.disabled} onClick={props.onRefresh}>刷新星球</button>
      <button id="search" disabled={props.disabled} onClick={props.onSearch}>查找最近目标</button>
    </div>
    <p id="target">{props.target}</p>
    <label htmlFor="count">发送探针数量</label>
    <input id="count" type="number" min="1" step="1" inputMode="numeric" value={props.count} disabled={props.disabled} onChange={event => props.onCountChange(event.target.value)} />
    <p>默认填入已同步库存，可修改数量。游戏实时增长的探针可能尚未计入。距离按地图坐标计算。</p>
    <button id="send" disabled={props.disabled || !props.canSend} onClick={props.onSend}>发送探针</button>
    <p id="status" role="status" aria-live="polite">{props.status}</p>
  </>;
}
