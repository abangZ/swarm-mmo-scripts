// One Web Lock owns the shared inventory ledger across same-origin tabs.
const lockName = 'swarm-helper-operations-v1';
const uncertainKey = 'swarm-helper-uncertain-v1';
export type OperationLane = 'expansion' | 'attack';
const lastKeys: Record<OperationLane, string> = { expansion: 'swarm-helper-last-operation-v1', attack: 'swarm-helper-last-attack-operation-v1' };
const activeRequests = new Set<string>();
const executing = new Set<OperationLane>();
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function markers(): Record<string, string> {
  const raw = localStorage.getItem(uncertainKey);
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.values(parsed).every(value => typeof value === 'string')) return parsed;
  } catch { /* Old versions stored one opaque token. It still blocks both lanes. */ }
  return { legacy: raw };
}
function saveMarkers(pending: Record<string, string>) {
  if (Object.keys(pending).length) localStorage.setItem(uncertainKey, JSON.stringify(pending));
  else localStorage.removeItem(uncertainKey);
}
export function unresolved(): boolean { return Object.values(markers()).some(token => !activeRequests.has(token)); }
export function clearUnresolved(): void { localStorage.removeItem(uncertainKey); }
export async function withControl<T>(work: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error('浏览器不支持跨标签页操作锁，无法安全启动操作。');
  return navigator.locks.request(lockName, { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('另一个标签页或助手操作正在运行，请先停止它。');
    if (unresolved()) throw new Error('上次发射结果未知。请核对游戏日志后解除锁定。');
    return work();
  });
}
export async function dispatch<T>(prepare: () => (() => Promise<T>) | null, interval: number, allowed: () => boolean, lane: OperationLane = 'expansion', signal?: AbortSignal): Promise<T | undefined> {
  if (executing.has(lane)) throw new Error('同一模式已有操作等待完成。');
  executing.add(lane);
  let timer: ReturnType<typeof setTimeout> | undefined, token: string | undefined;
  try {
    if (unresolved()) throw new Error('上次发射结果未知，已暂停。');
    const previous = Number(localStorage.getItem(lastKeys[lane]) ?? 0);
    const wait = Number.isFinite(previous) ? Math.max(0, Math.min(interval, interval - (Date.now() - previous))) : 0;
    const readyAt = Date.now() + wait;
    while (Date.now() < readyAt && !signal?.aborted) await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timeout); signal?.removeEventListener('abort', finish); resolve(); };
      const timeout = setTimeout(finish, readyAt - Date.now()); signal?.addEventListener('abort', finish, { once: true });
    });
    if (signal?.aborted || !allowed()) return;
    if (unresolved()) throw new Error('上次发射结果未知，已暂停。');
    const work = prepare();
    if (!work) return;
    const requestToken = token = `${lane}-${Date.now()}-${Math.random()}`;
    activeRequests.add(requestToken);
    // Each receipt removes only its own token. A reload loses activeRequests, so
    // every outstanding persisted token becomes unknown and blocks both lanes.
    saveMarkers({ ...markers(), [lane]: requestToken });
    // Invoke immediately: deferring to a microtask lets the other lane's planning
    // run between the recorded timestamp and the actual launch. Stamp after the
    // synchronous call, so its UI/adapter work cannot shorten the next interval.
    let requested: Promise<T>;
    try { requested = work(); }
    finally { localStorage.setItem(lastKeys[lane], String(Date.now())); }
    const request = Promise.resolve(requested).then(result => {
      const pending = markers();
      if (pending[lane] === requestToken) { delete pending[lane]; saveMarkers(pending); }
      return result;
    });
    return await Promise.race([request, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('发射确认超时，结果未知。已停止，请检查游戏日志。')), 15000);
    })]);
  } finally {
    clearTimeout(timer);
    if (token) activeRequests.delete(token);
    executing.delete(lane);
  }
}
export async function unlockAfterReview(): Promise<void> {
  if (!navigator.locks) throw new Error('浏览器不支持操作锁。');
  await navigator.locks.request(lockName, { ifAvailable: true }, lock => {
    if (!lock) throw new Error('仍有操作运行中，请先停止并等待完成。');
    clearUnresolved();
  });
}
