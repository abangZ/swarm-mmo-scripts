import { useEffect, useRef, useSyncExternalStore, type KeyboardEvent } from 'react';
import type { AppController, Mode } from './controller';
import { AutomationPanel } from '../ui/AutomationPanel';
import { RegionSettings } from '../ui/RegionSettings';
import { RecoveryPanel } from '../ui/RecoveryPanel';
import { StatusBadge, clockTime } from '../ui/RunStatus';
import styles from '../ui/panel.css';
import { appVersion } from './version';

export function App({ controller }: { controller: AppController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const toggle = useRef<HTMLButtonElement>(null);
  const collapse = useRef<HTMLButtonElement>(null);
  const expansionTab = useRef<HTMLButtonElement>(null);
  const attackTab = useRef<HTMLButtonElement>(null);
  const previousExpanded = useRef(state.expanded);
  useEffect(() => {
    if (state.expanded !== previousExpanded.current) {
      (state.expanded ? collapse : toggle).current?.focus();
      previousExpanded.current = state.expanded;
    }
  }, [state.expanded]);
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next: Mode = event.key === 'Home' ? 'expansion' : event.key === 'End' ? 'attack' : state.mode === 'expansion' ? 'attack' : 'expansion';
    controller.setMode(next);
    (next === 'expansion' ? expansionTab : attackTab).current?.focus();
  };
  const latest = state.logs.at(-1);
  return <>
    <style>{styles}</style>
    <button id="toggle" ref={toggle} hidden={state.expanded} aria-expanded={state.expanded} aria-controls="panel" onClick={controller.expand} title={latest?.message}>
      <span className="compact-heading"><strong>✦ Swarm 助手</strong></span>
      <span className="compact-modes"><span>扩张 <StatusBadge state={state.expansion} uncertain={state.uncertain} /></span><span>进攻 <StatusBadge state={state.attack} uncertain={state.uncertain} /></span></span>
      <span id="compact-log">{latest ? `${clockTime(latest.time)} · ${latest.mode === 'attack' ? '进攻' : '扩张'} · ${latest.message}` : '尚无运行日志，点击展开助手。'}</span>
    </button>
    <section id="panel" hidden={!state.expanded} aria-label="Swarm MMO 助手">
      <header><h2>✦ Swarm 助手</h2><button id="collapse" aria-label="收起助手" ref={collapse} onClick={controller.collapse}>收起 ↙</button></header>
      <div className="tabs" role="tablist" aria-label="助手模式">
        <button id="tab-expansion" role="tab" ref={expansionTab} aria-selected={state.mode === 'expansion'} aria-controls="expansion" tabIndex={state.mode === 'expansion' ? 0 : -1} onClick={() => controller.setMode('expansion')} onKeyDown={onTabKey}>自动扩张</button>
        <button id="tab-attack" role="tab" ref={attackTab} aria-selected={state.mode === 'attack'} aria-controls="attack" tabIndex={state.mode === 'attack' ? 0 : -1} onClick={() => controller.setMode('attack')} onKeyDown={onTabKey}>进攻模式</button>
      </div>
      {state.uncertain && !state.expansion.running && !state.attack.running && <p className="notice error" role="alert">上次发射结果未知，已锁定操作。请在下方核对并恢复。</p>}
      {(state.expansion.running || state.attack.running) && <div className="shared-status">
        <span>{state.expansion.running && state.attack.running ? '扩张与进攻同时运行' : state.expansion.running ? '自动扩张仍在运行' : '进攻模式仍在运行'} · 共享预算 · 独立队列</span>
        <button id="stop-all" onClick={controller.stopAll}>全部停止</button>
      </div>}
      {(['expansion', 'attack'] as const).map(mode => {
        const attack = mode === 'attack';
        const policy = state.policies[mode];
        const summary = policy.scope === 'circle' ? `中心 (${policy.x || '—'}, ${policy.y || '—'}) · 半径 ${policy.radius}` : '全部领地';
        return <div key={mode} id={mode} role="tabpanel" aria-labelledby={`tab-${mode}`} hidden={state.mode !== mode}>
          {attack && state.expansion.running && <p>自动扩张仍在运行，可切换 Tab 查看；停止进攻不会停止扩张。</p>}
          {!attack && state.attack.running && <p>进攻模式仍在运行，可切换 Tab 查看；停止扩张不会停止进攻。</p>}
          <AutomationPanel mode={mode} summary={summary} state={state[mode]} settings={attack ? state.attackSettings : state.settings} logs={state.logs} uncertain={state.uncertain}
            settingsOpen={attack ? state.attackSettingsOpen : state.settingsOpen}
            onToggleSettings={attack ? controller.toggleAttackSettings : controller.toggleSettings}
            onSettingChange={attack ? controller.setAttackSetting : controller.setSetting}
            onStart={attack ? controller.startAttack : controller.start} onStop={attack ? controller.stopAttack : controller.stop}
            region={<RegionSettings mode={mode} value={policy} preview={state.previews[mode]} disabled={state[mode].running}
              onChange={(key, value) => controller.setPolicy(mode, key, value)} onPick={kind => controller.pickCenter(mode, kind)}
              onFocus={() => controller.focusRegion(mode)} onFocusEnemy={controller.focusEnemy} onPickHub={controller.pickHub} onPreview={() => void controller.previewRegion(mode)} />} />
        </div>;
      })}
      <RecoveryPanel reviewed={state.reviewed} busy={state.unlocking} status={state.unlockStatus}
        onReviewedChange={controller.setReviewed} onUnlock={controller.unlock} />
    </section>
    <div className="app-version" title="当前页面实际加载的助手版本">Swarm 助手 v{appVersion}</div>
  </>;
}
