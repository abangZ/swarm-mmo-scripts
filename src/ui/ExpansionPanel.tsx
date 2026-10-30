import type { ExpansionState } from '../features/expansion/engine';
import { members, totalCount, completionMs, type ExpansionSettings as Settings } from '../features/expansion/types';
import type { SettingsForm } from '../app/settings';
import { ExpansionSettings } from './ExpansionSettings';

interface Props {
  state: ExpansionState;
  settings: SettingsForm;
  startDisabled: boolean;
  onSettingChange(key: keyof Settings, value: string): void;
  onStart(): void;
  onStop(): void;
}
export function ExpansionPanel({ state, settings, startDisabled, onSettingChange, onStart, onStop }: Props) {
  return <>
    <p>每颗己方星球寻找附近目标，统一分配。单星派兵为最新报价 +2；合兵按驻军 +1，再多留 2 个抵达探针，分别计入航行损耗。</p>
    <ExpansionSettings value={settings} disabled={state.running} onChange={onSettingChange} />
    <div className="row">
      <button id="start" disabled={startDisabled} onClick={onStart}>开始扩张</button>
      <button id="stop" disabled={!state.running} onClick={onStop}>停止</button>
    </div>
    <p id="auto-status" role="status" aria-live="polite">{state.phase}</p>
    <p id="auto-counts">本轮已发舰队 {state.sent} · 已占领 {state.captured} · 未占领 {state.missed} · 在途/已锁定 {state.flights}</p>
    <p id="auto-queue">{`${state.exact ? '当前候选集最优方案' : '有界优化方案'} · 待执行 ${state.queue.length}\n`}
      {state.queue.slice(0, 5).map(job => `${members(job).map(member => `#${member.sourceId}`).join(' + ')} → #${job.targetId}：${totalCount(job)} 探针，最晚抵达 ${(completionMs(job) / 1000).toFixed(0)} 秒`).join('\n')}
    </p>
    <p>优先增加规划时间内的占领数，其次更早抵达、更少耗兵。自动比较单星与合兵方案。收起面板继续运行，后台页面暂停发射。刷新后需手动重新启动。</p>
  </>;
}
