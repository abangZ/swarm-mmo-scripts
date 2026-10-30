import type { ActivityLog as Log } from '../app/controller';
import { clockTime } from './RunStatus';

export function ActivityLog({ entries }: { entries: Log[] }) {
  return <div className="log-card">
    <div className="section-heading"><h3>运行日志</h3><span className="muted">最近 {entries.length} / 100 条</span></div>
    {entries.length === 0 ? <p className="empty">尚无日志，启动后会记录扫描、派兵与占领结果。</p>
      : <ol id="activity-log" aria-label="运行日志，最新在前">
        {entries.slice().reverse().map(entry => <li key={entry.id} className={`log-entry ${entry.level}`}>
          <time dateTime={new Date(entry.time).toISOString()}>{clockTime(entry.time)}</time><span>{entry.message}</span>
        </li>)}
      </ol>}
  </div>;
}
