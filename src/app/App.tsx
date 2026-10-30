import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { AppController } from './controller';
import { ManualPanel } from '../ui/ManualPanel';
import { ExpansionPanel } from '../ui/ExpansionPanel';
import { RecoveryPanel } from '../ui/RecoveryPanel';
import styles from '../ui/panel.css';

export function App({ controller }: { controller: AppController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const toggle = useRef<HTMLButtonElement>(null);
  const collapse = useRef<HTMLButtonElement>(null);
  const previousExpanded = useRef(state.expanded);
  useEffect(() => {
    if (state.expanded !== previousExpanded.current) {
      (state.expanded ? collapse : toggle).current?.focus();
      previousExpanded.current = state.expanded;
    }
  }, [state.expanded]);
  const disabled = state.busy || state.uncertain || state.expansion.running;
  return <>
    <style>{styles}</style>
    <button id="toggle" ref={toggle} hidden={state.expanded} aria-expanded={state.expanded} aria-controls="panel" onClick={controller.expand}>
      {state.expansion.running ? '✦ 扩张中' : '✦ 助手'}
    </button>
    <section id="panel" hidden={!state.expanded} aria-label="Swarm MMO 助手">
      <header><h2>Swarm MMO 助手</h2><button id="collapse" ref={collapse} aria-label="收起助手" onClick={controller.collapse}>收起</button></header>
      <label htmlFor="action">操作</label>
      <select id="action" value={state.mode} onChange={event => controller.setMode(event.target.value === 'expansion' ? 'expansion' : 'manual')}>
        <option value="manual">发送到最近的无主行星</option><option value="expansion">自动扩张</option>
      </select>
      <div id="manual" hidden={state.mode !== 'manual'}>
        <ManualPanel planets={state.planets} sourceId={state.sourceId} count={state.count} target={state.target} status={state.status}
          canSend={state.canSend} disabled={disabled} onSourceChange={controller.setSource} onCountChange={controller.setCount}
          onRefresh={controller.refresh} onSearch={controller.search} onSend={controller.send} />
      </div>
      <div id="expansion" hidden={state.mode !== 'expansion'}>
        <ExpansionPanel state={state.expansion} settings={state.settings} startDisabled={disabled}
          onSettingChange={controller.setSetting} onStart={controller.start} onStop={controller.stop} />
      </div>
      <RecoveryPanel reviewed={state.reviewed} busy={state.unlocking} status={state.unlockStatus}
        onReviewedChange={controller.setReviewed} onUnlock={controller.unlock} />
    </section>
  </>;
}
