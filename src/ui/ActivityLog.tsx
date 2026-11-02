import { memo } from 'react';
import type { ActivityLog as Log } from '../app/controller';
import { clockTime } from './RunStatus';

// Existing log entries are immutable. Appending one message must not rebuild and
// reformat the other 99 rows on every sending/receipt/scan state update.
const LogEntry = memo(function LogEntry({ entry }: { entry: Log }) {
  return <li className={`log-entry ${entry.level}`}>
    <time dateTime={new Date(entry.time).toISOString()}>{clockTime(entry.time)}</time><span>{entry.message}</span>
  </li>;
});

export function ActivityLog({ entries, prefix = '' }: { entries: Log[]; prefix?: string }) {
  return <div className="log-card">
    <div className="section-heading"><h3>运行日志</h3><span className="muted">最近 {entries.length} / 100 条</span></div>
    {entries.length === 0 ? <p className="empty">尚无日志，启动后会记录扫描、派兵与占领结果。</p>
      : <ol id={`${prefix}activity-log`} className="activity-log" aria-label="运行日志，最新在前">
        {entries.slice().reverse().map(entry => <LogEntry key={entry.id} entry={entry} />)}
      </ol>}
  </div>;
}
