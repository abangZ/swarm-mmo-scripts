import type { Connection, Subscription } from './types';

export function subscribe(conn: Connection, query: string): Promise<Subscription> {
  return new Promise((resolve, reject) => {
    let handle: Subscription | undefined;
    let finished = false;
    const fail = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      handle?.unsubscribe();
      reject(new Error('星球数据加载失败或超时，请重试。'));
    };
    const timer = setTimeout(fail, 12000);
    try {
      handle = conn.subscriptionBuilder().onApplied(() => {
        queueMicrotask(() => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          resolve(handle!);
        });
      }).onError(fail).subscribe(query);
    } catch { fail(); }
  });
}
