import type { ReactNode } from 'react';
import type { Mode } from '../features/commander/types';
import type { ExpansionState } from '../features/expansion/engine';
import { sourceLabel, totalCount, completionMs, type ExpansionSettings as Settings } from '../features/expansion/types';
import type { SettingsForm } from '../app/settings';
import type { ActivityLog as Log } from '../app/controller';
import { ExpansionSettings } from './ExpansionSettings';
import { ActivityLog } from './ActivityLog';
import { RunStatus } from './RunStatus';

interface Props {
  mode: Mode;
  region: ReactNode;
  summary: string;
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
export function AutomationPanel({ mode, region, summary, state, settings, logs, uncertain, settingsOpen, onToggleSettings, onSettingChange, onStart, onStop }: Props) {
  const attack = mode === 'attack';
  const label = attack ? '进攻' : '扩张';
  const prefix = attack ? 'attack-' : '';
  const settingsId = `${mode}-settings`;
  return <>
    <div className="run-controls">
      <button id={`${prefix}start`} className="primary" disabled={uncertain || state.running} onClick={onStart}>{state.running ? `${label}已启动` : `开始${label}`}</button>
      <button id={`${prefix}stop`} className="danger" disabled={!state.running || state.activity === 'stopping'} onClick={onStop}>{state.activity === 'stopping' ? '正在停止…' : `停止${label}`}</button>
    </div>
    <div className="settings-card">
      <button id={`${prefix}settings-toggle`} className="settings-toggle" aria-expanded={settingsOpen} aria-controls={settingsId} onClick={onToggleSettings}>
        <span><strong>{label}设置</strong><small>{summary}</small></span>
        <span>{settingsOpen ? '收起 ▴' : '展开 ▾'}</span>
      </button>
      <div id={settingsId} className="settings-content" hidden={!settingsOpen}>
        {state.running && <p className="notice">运行中可查看设置，停止后可修改。</p>}
        {region}
        <ExpansionSettings attack={attack} value={settings} disabled={state.running} onChange={onSettingChange} />
        <p>{attack ? '附近兵力可直接进攻，远处余兵按需向中转星集结，两类任务交替执行。出击时重新报价，保留 1 个安全余量、产兵余量和设定的占领守军。' : '单星保留报价 +1 下限，并确保损耗后的余量；无主星合兵抵达兵力至少为驻军 +2。同样占点数优先少用舰队。'}</p>
      </div>
    </div>
    <RunStatus prefix={prefix} state={state} uncertain={uncertain} />
    <dl id={`${prefix}auto-counts`} className="run-stats">
      <div><dd>{state.sent}</dd><dt>已发舰队</dt></div>
      <div className="success"><dd>{state.captured}</dd><dt>已占领</dt></div>
      <div><dd>{state.flights}</dd><dt>在途 / 锁定</dt></div>
      <div><dd>{state.missed}</dd><dt>未占领</dt></div>
    </dl>
    <ActivityLog prefix={prefix} entries={logs.filter(log => !log.mode || log.mode === mode)} />
    <div className="queue-card">
      <div className="section-heading"><h3>待执行 <span className="count">{state.queue.length}</span></h3><span className="muted">{attack ? '集结 / 出击 · 共享预算' : state.exact ? '候选集最优方案' : '有界优化方案'}</span></div>
      {state.queue.length === 0 ? <p className="empty">{state.running ? '暂无排队任务，详见当前动作。' : '启动后根据兵力与附近目标生成计划。'}</p>
        : <ol id={`${prefix}auto-queue`} className="auto-queue" aria-label="派兵队列">
          {state.queue.slice(0, 5).map(job => <li key={String(job.targetId)}>
            <strong>{sourceLabel(job)} → #{String(job.targetId)}</strong>
            <span>{totalCount(job)} 探针 · 航行约 {Math.ceil(completionMs(job) / 1000)} 秒{job.kind === 'reinforce' ? ' · 己方中转集结' : job.support?.length ? ' · 合兵' : ''}</span>
          </li>)}
        </ol>}
      {state.queue.length > 5 && <p className="muted">另有 {state.queue.length - 5} 项，执行前会再次校验。</p>}
    </div>
    <p className="footer-note">收起或切换 Tab 继续运行；后台暂停派兵。发射确认后仍需等待扫描核实占领。</p>
  </>;
}
