import { useEffect, useState } from 'react';
import type { ExpansionActivity, ExpansionState } from '../features/expansion/engine';

const labels: Record<ExpansionActivity, string> = {
  idle: '未启动', starting: '启动中', scanning: '扫描中', waiting: '等待中', queued: '排队中', sending: '发送中',
  sent: '运行中', captured: '运行中', paused: '后台暂停', stopping: '停止中', stopped: '已停止', error: '已停止 · 异常',
};
export function statusLabel(state: ExpansionState, uncertain: boolean): string {
  return uncertain && !state.running ? '结果未知 · 已锁定' : labels[state.activity];
}
export function StatusBadge({ state, uncertain }: { state: ExpansionState; uncertain: boolean }) {
  const tone = uncertain && !state.running || state.activity === 'error' ? 'error'
    : state.activity === 'paused' || state.activity === 'stopping' ? 'warning' : state.running ? 'active' : 'idle';
  return <span className={`status-badge ${tone}`}><span className="status-dot" />{statusLabel(state, uncertain)}</span>;
}
export function clockTime(time: number): string {
  return new Date(time).toLocaleTimeString('zh-CN', { hour12: false });
}
export function RunStatus({ state, uncertain, prefix = '' }: { state: ExpansionState; uncertain: boolean; prefix?: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!state.running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.running, state.nextScanAt]);
  const nextScan = state.activity === 'scanning' ? '扫描中…'
    : state.activity === 'paused' ? '返回前台后扫描'
    : state.nextScanAt === null ? '—' : `${Math.max(0, Math.ceil((state.nextScanAt - now) / 1000))} 秒后`;
  return <div className="status-card">
    <div className="section-heading"><h3>当前动作</h3><StatusBadge state={state} uncertain={uncertain} /></div>
    <p id={`${prefix}auto-status`} className="auto-status" role="status" aria-live="polite">{state.phase}</p>
    {state.rally && <div className="rally-status"><strong>中转星 #{String(state.rally.hub)} → 目标 #{String(state.rally.target)}</strong>
      <p>中转可用 {state.rally.available} / 预计需要 {state.rally.required}<br />补给在途 {state.rally.incoming} · 待募集来源 {state.rally.sources} 颗</p>
    </div>}
    {state.planning && <div className="expansion-progress">
      <p>本轮已安排 {state.planning.assigned} / {state.planning.sources} 颗来源 · {state.planning.ready} 颗具备可行方案</p>
      {!!state.planning.idle.length && <details><summary>未派兵原因（最多显示 6 颗）</summary>
        <ul>{state.planning.idle.map(source => <li key={String(source.sourceId)}>
          <strong>#{String(source.sourceId)} ({source.x}, {source.y}) · 可用 {source.available}</strong><br />{source.reason}
        </li>)}</ul>
      </details>}
    </div>}
    <dl className="scan-stats">
      <div><dt>己方星球</dt><dd>{state.lastScanAt === null ? '—' : state.ownedCount}</dd></div>
      <div><dt>候选目标</dt><dd>{state.lastScanAt === null ? '—' : state.candidateCount}</dd></div>
      <div><dt>下次扫描</dt><dd id={`${prefix}next-scan`}>{nextScan}</dd></div>
    </dl>
    <p className="muted">{state.lastScanAt === null ? '启动后加载战区与周围情报。' : `最近扫描 ${clockTime(state.lastScanAt)} · 每秒重新评估可用兵力与目标`}</p>
  </div>;
}
