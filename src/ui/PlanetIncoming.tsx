import { useLayoutEffect, useRef, useState } from 'react';
import type { InspectorSnapshot } from '../app/planet-inspector';
import type { FleetTotal } from '../game/incoming-fleets';
import type { MenuBounds } from '../game/planet-menu';
import styles from './planet-incoming.css';

export function inspectorPosition(bounds: MenuBounds, width: number, height: number, viewportWidth: number, viewportHeight: number) {
  const pad = 8;
  let left = (bounds.left + bounds.right - width) / 2, top = bounds.bottom + pad;
  if (top + height > viewportHeight - pad) {
    if (bounds.top - pad - height >= pad) top = bounds.top - pad - height;
    else { left = bounds.right + pad + width <= viewportWidth - pad ? bounds.right + pad : bounds.left - pad - width; top = bounds.top; }
  }
  return { left: Math.max(pad, Math.min(left, viewportWidth - width - pad)), top: Math.max(pad, Math.min(top, viewportHeight - height - pad)) };
}
const numberFormat = new Intl.NumberFormat('zh-CN');
function FleetRow({ label, kind, total }: { label: string; kind: string; total: FleetTotal }) {
  return <div className={kind}><span>{label}</span><strong>{total.unknown ? (total.probes === '0' ? '未知' : `≥ ${numberFormat.format(BigInt(total.probes))}`) : numberFormat.format(BigInt(total.probes))}</strong><span>兵 · {total.fleets} 支</span></div>;
}
export function PlanetIncoming({ snapshot, onLoad }: { snapshot: InspectorSnapshot | null; onLoad(): void }) {
  const ref = useRef<HTMLElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  useLayoutEffect(() => {
    if (!snapshot || !ref.current) return;
    const place = () => {
      const rect = ref.current!.getBoundingClientRect();
      setPosition(inspectorPosition(snapshot.menu.bounds, rect.width, rect.height, window.innerWidth, window.innerHeight));
    };
    place(); window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [snapshot]);
  if (!snapshot) return null;
  const { incoming } = snapshot;
  const idle = incoming.status === 'idle';
  return <><style>{styles}</style><section ref={ref} className={`incoming${idle ? ' incoming-idle' : ''}`} aria-label="此星球在途兵力" style={{ ...position, zIndex: snapshot.menu.zIndex + 1 }}>
    {!idle && <header>飞往此星球 <small>在途兵力</small></header>}
    {incoming.status === 'idle' ? <button className="query-icon" type="button" title="查询在途兵力" aria-label="查询在途兵力" onClick={onLoad}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" />
        <path d="M12 12 18.4 5.6" /><circle cx="7" cy="16" r="1" fill="currentColor" stroke="none" />
      </svg>
    </button> : incoming.status === 'loading' ? <p>加载中…</p> : incoming.status === 'error' ? <><p>数据不可用</p><button type="button" onClick={onLoad}>重新查询</button></> : <>
      <FleetRow label="敌方在途" kind="enemy" total={incoming.totals.enemy} />
      <FleetRow label="我的在途" kind="mine" total={incoming.totals.mine} />
      {incoming.totals.ally.fleets > 0 && <FleetRow label="盟友在途" kind="ally" total={incoming.totals.ally} />}
      {Object.values(incoming.totals).some(t => t.unknown > 0) && <p>部分舰队兵力未知</p>}
      <footer>按舰队记录统计，非损耗后抵达兵力</footer>
    </>}
  </section></>;
}
