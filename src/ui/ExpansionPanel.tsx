import type { ExpansionState } from '../features/expansion/engine';
import { members, totalCount, completionMs, type ExpansionSettings as Settings } from '../features/expansion/types';
import type { SettingsForm } from '../app/settings';
import type { ActivityLog as Log } from '../app/controller';
import { ExpansionSettings } from './ExpansionSettings';
import { ActivityLog } from './ActivityLog';
import { RunStatus } from './RunStatus';

interface Props {
  state: ExpansionState;
  settings: SettingsForm;
  logs: Log[];
  uncertain: boolean;
  settingsOpen: boolean;
  onToggleSettings(): void;
  onSettingChange(key: keyof Settings, value: string): void;
  onStart(): void;
  onStop(): void;
}
export function ExpansionPanel({ state, settings, logs, uncertain, settingsOpen, onToggleSettings, onSettingChange, onStart, onStop }: Props) {
  return <>
    <div className="run-controls">
      <button id="start" className="primary" disabled={uncertain || state.running} onClick={onStart}>{state.running ? '扩张已启动' : '开始扩张'}</button>
      <button id="stop" className="danger" disabled={!state.running || state.activity === 'stopping'} onClick={onStop}>{state.activity === 'stopping' ? '正在停止…' : '停止扩张'}</button>
    </div>
    <div className="settings-card">
      <button id="settings-toggle" className="settings-toggle" aria-expanded={settingsOpen} aria-controls="expansion-settings" onClick={onToggleSettings}>
        <span><strong>扩张设置</strong><small>{settings.scanMs} 秒扫描 · 最多 {settings.maxSources} 星协同</small></span>
        <span>{settingsOpen ? '收起 ▴' : '展开 ▾'}</span>
      </button>
      <div id="expansion-settings" hidden={!settingsOpen}>
        {state.running && <p className="notice">运行中可查看设置，停止后可修改。</p>}
        <ExpansionSettings value={settings} disabled={state.running} onChange={onSettingChange} />
        <p>单星按最新报价 +2 派兵；合兵分别计入航行损耗，抵达兵力至少为驻军 +3。</p>
      </div>
    </div>
    <RunStatus state={state} uncertain={uncertain} />
    <dl id="auto-counts" className="run-stats">
      <div><dd>{state.sent}</dd><dt>已发舰队</dt></div>
      <div className="success"><dd>{state.captured}</dd><dt>已占领</dt></div>
      <div><dd>{state.flights}</dd><dt>在途 / 锁定</dt></div>
      <div><dd>{state.missed}</dd><dt>未占领</dt></div>
    </dl>
    <ActivityLog entries={logs} />
    <div className="queue-card">
      <div className="section-heading"><h3>待执行 <span className="count">{state.queue.length}</span></h3><span className="muted">{state.exact ? '候选集最优方案' : '有界优化方案'}</span></div>
      {state.queue.length === 0 ? <p className="empty">{state.running ? '暂无排队任务，详见当前动作。' : '启动后根据兵力与附近目标生成计划。'}</p>
        : <ol id="auto-queue" aria-label="派兵队列">
          {state.queue.slice(0, 5).map(job => <li key={String(job.targetId)}>
            <strong>{members(job).map(member => `#${member.sourceId}`).join(' + ')} → #{String(job.targetId)}</strong>
            <span>{totalCount(job)} 探针 · 航行约 {Math.ceil(completionMs(job) / 1000)} 秒{job.support?.length ? ' · 合兵' : ''}</span>
          </li>)}
        </ol>}
      {state.queue.length > 5 && <p className="muted">另有 {state.queue.length - 5} 项，执行前会再次校验。</p>}
    </div>
    <p className="footer-note">收起或切换 Tab 继续运行；后台暂停派兵。发射确认后仍需等待扫描核实占领。</p>
  </>;
}
