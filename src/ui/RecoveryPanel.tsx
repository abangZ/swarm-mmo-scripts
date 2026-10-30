interface Props {
  reviewed: boolean;
  busy: boolean;
  status: string;
  onReviewedChange(value: boolean): void;
  onUnlock(): void;
}
export function RecoveryPanel({ reviewed, busy, status, onReviewedChange, onUnlock }: Props) {
  return <details>
    <summary>发射结果未知时恢复</summary>
    <p>请先核对游戏日志与在途舰队。解除锁定不会自动启动扩张。</p>
    <label><input id="reviewed" type="checkbox" checked={reviewed} disabled={busy} onChange={event => onReviewedChange(event.target.checked)} /> 我已核实游戏中的发射结果</label>
    <button id="unlock" disabled={busy} onClick={onUnlock}>解除发射锁定</button>
    <p id="unlock-status" role="status">{status}</p>
  </details>;
}
