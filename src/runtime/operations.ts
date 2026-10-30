// One Web Lock covers both automation and manual helper actions across same-origin tabs.
const lockName = 'swarm-helper-operations-v1';
const uncertainKey = 'swarm-helper-uncertain-v1';
const lastKey = 'swarm-helper-last-operation-v1';
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export function unresolved(): boolean { return localStorage.getItem(uncertainKey) !== null; }
export function clearUnresolved(): void { localStorage.removeItem(uncertainKey); }
export async function withControl<T>(work: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error('浏览器不支持跨标签页操作锁，无法安全启动操作。');
  return navigator.locks.request(lockName, { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('另一个标签页或助手操作正在运行，请先停止它。');
    if (unresolved()) throw new Error('上次发射结果未知。请核对游戏日志后解除锁定。');
    return work();
  });
}
export async function dispatch<T>(prepare: () => (() => Promise<T>) | null, interval: number, allowed: () => boolean): Promise<T | undefined> {
  if (unresolved()) throw new Error('上次发射结果未知，已暂停。');
  const previous = Number(localStorage.getItem(lastKey) ?? 0);
  const wait = Number.isFinite(previous) ? Math.max(0, Math.min(interval, interval - (Date.now() - previous))) : 0;
  if (wait) await sleep(wait);
  if (!allowed()) return;
  const work = prepare();
  if (!work) return;
  const token = `${Date.now()}-${Math.random()}`;
  // Written before transmission: survives reload/crash and never triggers an automatic retry.
  localStorage.setItem(uncertainKey, token);
  localStorage.setItem(lastKey, String(Date.now()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const request = Promise.resolve().then(work).then(result => {
    if (localStorage.getItem(uncertainKey) === token) localStorage.removeItem(uncertainKey);
    return result;
  });
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('发射确认超时，结果未知。已停止，请检查游戏日志。')), 15000);
    })]);
  } finally { clearTimeout(timer); }
}
export async function unlockAfterReview(): Promise<void> {
  if (!navigator.locks) throw new Error('浏览器不支持操作锁。');
  await navigator.locks.request(lockName, { ifAvailable: true }, lock => {
    if (!lock) throw new Error('仍有操作运行中，请先停止并等待完成。');
    clearUnresolved();
  });
}
