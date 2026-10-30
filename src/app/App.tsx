import { useEffect, useRef, useSyncExternalStore, type KeyboardEvent } from 'react';
import type { AppController, Mode } from './controller';
import { ExpansionPanel } from '../ui/ExpansionPanel';
import { RecoveryPanel } from '../ui/RecoveryPanel';
import { StatusBadge, clockTime } from '../ui/RunStatus';
import styles from '../ui/panel.css';

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
      <span className="compact-heading"><strong>✦ 自动扩张</strong><StatusBadge state={state.expansion} uncertain={state.uncertain} /></span>
      <span id="compact-log">{latest ? `${clockTime(latest.time)} · ${latest.message}` : '尚无运行日志，点击展开助手。'}</span>
    </button>
    <section id="panel" hidden={!state.expanded} aria-label="Swarm MMO 助手">
      <header><h2>✦ Swarm 助手</h2><button id="collapse" aria-label="收起助手" ref={collapse} onClick={controller.collapse}>收起 ↙</button></header>
      <div className="tabs" role="tablist" aria-label="助手模式">
        <button id="tab-expansion" role="tab" ref={expansionTab} aria-selected={state.mode === 'expansion'} aria-controls="expansion" tabIndex={state.mode === 'expansion' ? 0 : -1} onClick={() => controller.setMode('expansion')} onKeyDown={onTabKey}>自动扩张</button>
        <button id="tab-attack" role="tab" ref={attackTab} aria-selected={state.mode === 'attack'} aria-controls="attack" tabIndex={state.mode === 'attack' ? 0 : -1} onClick={() => controller.setMode('attack')} onKeyDown={onTabKey}>进攻模式 <small>即将推出</small></button>
      </div>
      {state.uncertain && !state.expansion.running && <p className="notice error" role="alert">上次发射结果未知，已锁定操作。请在下方核对并恢复。</p>}
      <div id="expansion" role="tabpanel" aria-labelledby="tab-expansion" hidden={state.mode !== 'expansion'}>
        <ExpansionPanel state={state.expansion} settings={state.settings} logs={state.logs} uncertain={state.uncertain} settingsOpen={state.settingsOpen}
          onToggleSettings={controller.toggleSettings} onSettingChange={controller.setSetting} onStart={controller.start} onStop={controller.stop} />
      </div>
      <div id="attack" role="tabpanel" aria-labelledby="tab-attack" hidden={state.mode !== 'attack'}>
        <div className="placeholder"><span className="placeholder-icon">◎</span><h3>进攻模式开发中</h3><p>后续在这里配置进攻目标与派兵策略。</p></div>
        {state.expansion.running && <div className="status-card">
          <div className="section-heading"><strong>自动扩张仍在运行</strong><StatusBadge state={state.expansion} uncertain={state.uncertain} /></div>
          <p>{state.expansion.phase}</p>
          <div className="run-controls"><button onClick={() => controller.setMode('expansion')}>查看扩张</button><button className="danger" disabled={state.expansion.activity === 'stopping'} onClick={controller.stop}>停止扩张</button></div>
        </div>}
      </div>
      <RecoveryPanel reviewed={state.reviewed} busy={state.unlocking} status={state.unlockStatus}
        onReviewedChange={controller.setReviewed} onUnlock={controller.unlock} />
    </section>
  </>;
}
