import { useState } from 'react';
import type { Mode } from '../features/commander/types';
import type { PolicyForm, RegionPreview } from '../app/regions';

interface Props {
  mode: Mode; value: PolicyForm; preview: RegionPreview; disabled: boolean;
  onChange(key: keyof PolicyForm, value: string): void;
  onPick(kind: 'selection' | 'view'): void;
  onPreview(): void; onFocus(): void; onFocusEnemy(id: string): void;
  onPickHub(): void;
}
export function RegionSettings({ mode, value, preview, disabled, onChange, onPick, onPreview, onFocus, onFocusEnemy, onPickHub }: Props) {
  const [search, setSearch] = useState('');
  const [hubSearch, setHubSearch] = useState('');
  const id = (key: string) => `${mode}-${key === 'radius' ? 'zone-radius' : key}`;
  const enemies = preview.enemies.filter(e => `${e.name} ${e.id}`.toLowerCase().includes(search.toLowerCase()));
  const hubs = (preview.hubs ?? []).filter(h => `${h.id} ${h.x},${h.y}`.includes(hubSearch));
  return <div className="region-settings">
    <h3>作战区域</h3>
    {mode === 'expansion' && <><label htmlFor={id('scope')}>参与范围</label><select id={id('scope')} disabled={disabled} value={value.scope} onChange={e => onChange('scope', e.target.value)}>
      <option value="all">全部领地</option><option value="circle">固定区域（推荐分区运行）</option>
    </select></>}
    <div className="region-actions">
      <button id={id('pick-view')} disabled={disabled} onClick={() => onPick('view')}>用地图视野中心</button>
      <button id={id('pick-selection')} disabled={disabled} onClick={() => onPick('selection')}>用选中星球</button>
    </div>
    {value.scope === 'circle' && <>
      <div className="coordinate-grid">
        {(['x', 'y', 'radius'] as const).map(key => <div key={key}><label htmlFor={id(key)}>{key === 'radius' ? '区域半径' : `中心 ${key.toUpperCase()}`}</label>
          <input id={id(key)} type="number" step="1" min={key === 'radius' ? 1 : undefined} max={key === 'radius' ? 128 : undefined} value={value[key]} disabled={disabled} onChange={e => onChange(key, e.target.value)} />
        </div>)}
      </div>
      <div className="region-actions"><button id={id('preview')} disabled={preview.busy || disabled} onClick={onPreview}>{preview.busy ? '加载中…' : '加载区域与敌人'}</button><button onClick={onFocus}>地图定位</button></div>
      <p>仅区域内星球出兵，目标也须位于区域内。占领新星球不会扩大边界。</p>
    </>}
    {preview.message && <p id={id('preview-status')} role="status">{preview.message}</p>}
    {mode === 'attack' && <>
      <label htmlFor={id('enemy-search')}>筛选敌人名字 / ID</label>
      <input id={id('enemy-search')} type="search" value={search} placeholder="先加载区域，再按名字查找" onChange={e => setSearch(e.target.value)} />
      <label htmlFor={id('enemy')}>进攻对象</label>
      <select id={id('enemy')} disabled={disabled} value={value.enemy} onChange={e => onChange('enemy', e.target.value)}>
        <option value="">区域内所有非盟友</option>
        {value.enemy && !enemies.some(e => e.id === value.enemy) && <option value={value.enemy}>已指定：{value.enemy.slice(0, 12)}…</option>}
        {enemies.map(enemy => <option value={enemy.id} key={enemy.id}>{enemy.name} · {enemy.count} 颗 · {enemy.id.slice(0, 6)}</option>)}
      </select>
      <button className="locate-enemy" disabled={!preview.enemies.some(e => e.id === value.enemy)} onClick={() => onFocusEnemy(value.enemy)}>定位该敌人在区域内的星球</button>
      <p>自动排除自己与同联盟玩家；联盟关系变化后会重新校验。</p>
      <h3 className="policy-heading">中转集结</h3>
      <label htmlFor={id('hub-search')}>筛选己方中转星 ID / 坐标</label>
      <input id={id('hub-search')} type="search" value={hubSearch} onChange={e => setHubSearch(e.target.value)} placeholder="加载区域后可选择，或从地图读取" />
      <label htmlFor={id('rallyId')}>初始中转星</label>
      <select id={id('rallyId')} disabled={disabled} value={value.rallyId} onChange={e => onChange('rallyId', e.target.value)}>
        <option value="">自动选择合适据点</option>
        {value.rallyId && !hubs.some(h => h.id === value.rallyId) && <option value={value.rallyId}>已指定 #{value.rallyId}</option>}
        {hubs.map(hub => <option key={hub.id} value={hub.id}>#{hub.id} · ({hub.x}, {hub.y}) · {hub.probes} 探针</option>)}
      </select>
      <button id={id('pick-hub')} className="locate-enemy" disabled={disabled} onClick={onPickHub}>用地图选中的己方行星作中转</button>
      <label htmlFor={id('rallyMinutes')}>补给最长航行时间（分钟，1–240）</label>
      <input id={id('rallyMinutes')} type="number" min="1" max="240" disabled={disabled} value={value.rallyMinutes} onChange={e => onChange('rallyMinutes', e.target.value)} />
      <label htmlFor={id('advanceHub')}>攻下据点后</label>
      <select id={id('advanceHub')} disabled={disabled} value={value.advanceHub} onChange={e => onChange('advanceHub', e.target.value)}>
        <option value="yes">前移中转星，在原战区内继续推进</option><option value="no">保留初始中转星</option>
      </select>
        <p>附近星球可直接攻敌；其余兵力按需集结，每批最多 50 个来源。中转星实际收到兵力后再出击，选定中转星不限制其他星球直接进攻。</p>
    </>}
    <h3 className="policy-heading">动态留兵</h3>
    <div className="coordinate-grid">
      <div><label htmlFor={id('frontlinePercent')}>前线留兵 %</label><input id={id('frontlinePercent')} type="number" min="0" max="90" disabled={disabled} value={value.frontlinePercent} onChange={e => onChange('frontlinePercent', e.target.value)} /></div>
      <div><label htmlFor={id('threatRadius')}>敌方警戒距离</label><input id={id('threatRadius')} type="number" min="1" max="128" disabled={disabled} value={value.threatRadius} onChange={e => onChange('threatRadius', e.target.value)} /></div>
      {mode === 'attack' && <div><label htmlFor={id('holdProbes')}>占领后留兵</label><input id={id('holdProbes')} type="number" min="2" max="1000000" disabled={disabled} value={value.holdProbes} onChange={e => onChange('holdProbes', e.target.value)} /></div>}
    </div>
    <p>警戒距离内有敌人的来源提高留兵；已知来袭另外预留守军。启用游戏自动升级 / 转发的来源不参与派兵。</p>
  </div>;
}
