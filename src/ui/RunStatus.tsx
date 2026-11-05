import { useEffect, useState } from 'react';
import type { PlanningTiming } from '../runtime/planning';

const schedulerWait = (timing: PlanningTiming) => Math.round(timing.waitMs + (timing.waitingSince === undefined ? 0 : Math.max(0, performance.now() - timing.waitingSince)));
import type { ExpansionActivity, ExpansionState } from '../features/expansion/engine';

const labels: Record<ExpansionActivity, string> = {
  idle: '未启动', starting: '启动中', scanning: '扫描中', waiting: '等待中', queued: '排队中', sending: '发送中',
  sent: '运行中', captured: '运行中', paused: '暂缓操作', stopping: '停止中', stopped: '已停止', error: '已停止 · 异常',
};
export function statusLabel(state: ExpansionState, uncertain: boolean): string {
  if (state.running && !['paused', 'stopping', 'error', 'starting'].includes(state.activity) && state.work) {
    if (state.work.dispatch) return state.activity === 'sending' ? '等待确认' : '等待发射';
    if (state.work.plan) return '规划中';
    if (state.work.scanning) return '扫描中';
    if (state.queue.length) return '排队中';
    if (state.work.background) return '后台确认中';
    return '监测变化中';
  }
  return uncertain && !state.running ? '结果未知 · 已锁定' : labels[state.activity];
}
export function StatusBadge({ state, uncertain }: { state: ExpansionState; uncertain: boolean }) {
  const tone = uncertain && !state.running || state.activity === 'error' ? 'error'
    : state.activity === 'paused' || state.activity === 'stopping' ? 'warning' : state.running ? 'active' : 'idle';
  return <span className={`status-badge ${tone}`}><span className="status-dot" />{statusLabel(state, uncertain)}</span>;
}
const clockFormatter = new Intl.DateTimeFormat('zh-CN', { hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false });
export function clockTime(time: number): string { return clockFormatter.format(time); }
export function RunStatus({ state, uncertain, prefix = '', peaceful = false }: { state: ExpansionState; uncertain: boolean; prefix?: string; peaceful?: boolean }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!state.running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.running, state.nextScanAt]);
  const live = state.running && !['paused', 'stopping', 'error', 'starting'].includes(state.activity) ? state.work : undefined;
  // Frontline checks run roughly every second. Treat them as background
  // monitoring, not a replacement for the main action or a transient row.
  const slowFrontier = live?.frontier !== undefined && now - live.frontier >= 2000;
  const elapsed = (start: number) => `${Math.max(0, Math.floor((now - start) / 1000))} 秒`;
  const nextScan = live?.scanning ? '扫描中…'
    : state.activity === 'paused' ? prefix ? '返回前台后扫描' : '自动恢复后扫描'
    : state.nextScanAt === null ? live?.plan ? '本轮规划后计时' : '—' : `${Math.max(0, Math.ceil((state.nextScanAt - now) / 1000))} 秒后`;
  return <div className="status-card">
    <div className="section-heading"><h3>当前动作</h3><StatusBadge state={state} uncertain={uncertain} /></div>
    <p id={`${prefix}auto-status`} className="auto-status" role="status" aria-live="polite">{live
      ? live.dispatch ?? (live.plan ? `正在${live.plan.stage}` : live.scanning ? '正在更新战区覆盖与情报' : state.queue.length ? `按已有计划执行，待执行 ${state.queue.length} 项` : live.background ? `后台确认 / 同步 ${live.background} 项；监测前线变化` : '暂无待执行任务；监测兵力变化，等待新机会')
      : state.phase}</p>
    {live && <div className="expansion-progress">
      {live.plan && <p>全局规划：{live.plan.stage}{live.plan.total !== undefined ? ` · 已检查 ${live.plan.completed ?? 0}/${live.plan.total} 颗来源` : ''} · 已耗时 {elapsed(live.plan.startedAt)}；已有队列继续执行</p>}
      {!prefix && <p className="frontier-status">{peaceful ? '陨石监测' : '前线监测'}：{!peaceful && slowFrontier ? `正在检查 · ${elapsed(live.frontier!)}` : '已开启'}</p>}
      <p>待执行 {state.queue.length} 项 · 后台回执 / 同步 {live.background ?? 0} 项{live.inventory ? ` · 库存重试 ${live.inventory} 颗来源` : ''}</p>
      <p className="muted">最近事件：{state.phase}</p>
    </div>}
    {state.sun && <p>{state.sun.waiting ?? `本轮恒星目标 #${state.sun.target}${state.sun.hub ? `，汇集星球 #${state.sun.hub}` : ''}`}</p>}
    {state.logistics?.map(plan => <div className="rally-status" key={plan.kind}>
      <strong>{plan.kind === 'sun' ? '恒星募集' : '前线补给'}：#{String(plan.hub)} → #{String(plan.target)}</strong>
      <p>{plan.phase} · 可用 {plan.available}/{plan.required} · 补给在途 {plan.incoming}<br />
        待募集 {plan.donors} 颗 · 航路已检查 {plan.checked}/{plan.total}<br />
        不升级预计占领：{Number.isFinite(plan.readyMs) ? `${Math.ceil(plan.readyMs / 60000)} 分钟` : '等待足够兵力'}
        {plan.upgradeMs !== undefined ? `；先升 2 级约 ${Math.ceil(plan.upgradeMs / 60000)} 分钟` : ''}</p>
    </div>)}
    {state.diagnostics && <details><summary>耗时与数据来源</summary>
      {state.work?.planningTiming && <p>本轮分片计算 {Math.round(state.work.planningTiming.computeMs)} ms · 调度等待 {schedulerWait(state.work.planningTiming)} ms · 恢复检查 {Math.round(state.work.planningTiming.refreshMs)} ms（{state.work.planningTiming.slices} 次分片）</p>}
      {state.work?.frontierTiming && <p>最近前线检查：计算 {Math.round(state.work.frontierTiming.computeMs)} ms · 调度等待 {schedulerWait(state.work.frontierTiming)} ms</p>}
      <p>内存快照 {Math.round(state.diagnostics.readMs)} ms · 最近覆盖扫描 {Math.round(state.diagnostics.scanMs)} ms<br />
        其中官方库存遍历 {Math.round(state.diagnostics.ownedBodiesMs ?? 0)} ms · 累计快照 {state.diagnostics.readCalls ?? 0} 次 / {Math.round(state.diagnostics.readTotalMs ?? 0)} ms<br />
        扫描新增订阅 {state.diagnostics.newSubscriptions} 个 / 复用 {state.diagnostics.reusedSubscriptions} 个<br />
        累计原生内存报价 {state.diagnostics.quoteCalls} 次 / {Math.round(state.diagnostics.quoteMs)} ms<br />
        单次报价平均 {Math.round(state.diagnostics.quoteMs / Math.max(1, state.diagnostics.quoteCalls))} ms · 最慢 {Math.round(state.diagnostics.quoteMaxMs ?? 0)} ms · 超过 8 ms 共 {state.diagnostics.slowQuotes ?? 0} 次<br />
        库存同步 {state.diagnostics.syncCalls ?? 0} 批 / {state.diagnostics.syncQueries ?? 0} 次订阅 · 正在同步 {state.diagnostics.syncActive ?? 0} 批<br />
        最近同步 {Math.round(state.diagnostics.syncMs)} ms · 累计 {Math.round(state.diagnostics.syncTotalMs ?? 0)} ms（并发时间不相加到规划耗时）</p>
      <p>本次后勤更新 {Math.round(state.work?.logisticsMs ?? 0)} ms · 航路新算 {state.work?.logisticsRoutes ?? 0} / 复用 {state.work?.logisticsReused ?? 0} 条</p>
      <p className="muted">规划读取游戏内存；覆盖订阅和发射后的库存确认需要服务器同步。</p>
    </details>}
    {state.metrics && <div className="expansion-progress">
      <p>本次占领：星球 {state.metrics.planets} · 恒星 {state.metrics.suns} · 陨石 {state.metrics.meteorites}；确认升级 {state.metrics.upgrades} 次</p>
      <p>已提交兵力 {state.metrics.sentProbes} · 占领时新增基础产能 {state.metrics.addedBaseProduction}/分钟</p>
      <p>持续保有 30 分钟：{state.metrics.retention30.held}/{state.metrics.retention30.total} · 60 分钟：{state.metrics.retention60.held}/{state.metrics.retention60.total}（仅已到观察时间的星球与恒星）</p>
      {!!state.exposed && <p>已观测到 {state.exposed} 个前沿暴露目标，按扩张取向处理。</p>}
    </div>}
    {!!state.meteorites?.length && <details><summary>陨石快速检查（最多 6 颗）</summary><ul>{state.meteorites.map(report => <li key={String(report.targetId)}><strong>陨石 #{String(report.targetId)}</strong><br />{report.reason}</li>)}</ul></details>}
    {!!state.decisions?.length && <details><summary>本轮选择原因</summary><ul>{state.decisions.map((reason, index) => <li key={index}>{reason}</li>)}</ul></details>}
    {(state.rallies ?? (state.rally ? [state.rally] : [])).map(rally => <div className="rally-status" key={String(rally.hub)}><strong>中转星 #{String(rally.hub)} → 目标 #{String(rally.target)}</strong>
      <p>中转可用 {rally.available} / 预计需要 {rally.required}<br />补给在途 {rally.incoming} · 待募集来源 {rally.sources} 颗</p>
    </div>)}
    {state.attackDiagnostics && <div className="expansion-progress">
      <p>可用兵力 {state.attackDiagnostics.available} · 来源 {state.attackDiagnostics.sources} 颗（无预算 {state.attackDiagnostics.noBudget} 颗）</p>
      <p>敌方目标 {state.attackDiagnostics.targets} · 在途 / 锁定 {state.attackDiagnostics.blocked} · 范围内无可选目标的来源 {state.attackDiagnostics.noTargets} 颗</p>
      <p>检查路线：可直攻 {state.attackDiagnostics.feasible} · 航时超限 {state.attackDiagnostics.tooSlow} · 兵力不足 {state.attackDiagnostics.insufficient} · 报价不可用 {state.attackDiagnostics.noQuote}</p>
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
    <p className="muted">{state.lastScanAt === null ? '启动后加载战区与周围情报。' : `最近扫描 ${clockTime(state.lastScanAt)} · 本轮规划完成后开始扫描倒计时`}</p>
  </div>;
}
