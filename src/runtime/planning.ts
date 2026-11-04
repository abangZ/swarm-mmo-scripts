export function finishPlanning<T>(steps: Generator<void, T>): T {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

export const yieldToPage = () => {
  const scheduler = (globalThis as typeof globalThis & { scheduler: { postTask(task: () => void, options: { priority: 'background' }): Promise<void> } }).scheduler;
  // Default-priority scheduler.yield() continuations can outrank dispatch timers
  // for an entire planning round. Background priority leaves those timers room.
  return scheduler.postTask(() => {}, { priority: 'background' });
};

// Short frontline work must not wait behind a background-priority empire scan.
// A timer yields to rendering and the existing dispatch timers between slices.
export const yieldToFrontier = () => new Promise<void>(resolve => setTimeout(resolve, 0));
export interface PlanningTiming { computeMs: number; waitMs: number; refreshMs: number; slices: number; waitingSince?: number }
export const planningTiming = (): PlanningTiming => ({ computeMs: 0, waitMs: 0, refreshMs: 0, slices: 0 });

/** Keep one planner/executor, but let rendering and stop/configuration events run. */
export async function runPlanning<T>(steps: Generator<void, T>, current: () => boolean, resume = () => {}, yieldTask = yieldToPage, sliceMs = 8, timing?: PlanningTiming, maxSliceMs = sliceMs): Promise<T | undefined> {
  let done = false;
  let started = performance.now(), computing = true;
  let deadline = started + sliceMs;
  try {
    while (current()) {
      const step = steps.next();
      if (step.done) { done = true; return step.value; }
      if (performance.now() >= deadline) {
        const waitAt = performance.now();
        if (timing) { timing.computeMs += waitAt - started; timing.slices++; timing.waitingSince = waitAt; }
        computing = false;
        try { await yieldTask(); } finally { if (timing) { timing.waitMs += performance.now() - waitAt; timing.waitingSince = undefined; } }
        const waited = Math.max(0, performance.now() - waitAt);
        if (!current()) return;
        const refreshAt = performance.now();
        try { resume(); } finally { if (timing) timing.refreshMs += performance.now() - refreshAt; }
        started = performance.now(); computing = true;
        // Only the full expansion planner opts in. Amortize expensive background
        // scheduling with a small bounded increase, without raising task priority
        // or chaining microtasks ahead of dispatch/input timers. Cheap waits return
        // to the original slice. A single native call cannot be preempted.
        deadline = started + Math.min(maxSliceMs, sliceMs + waited / 2);
      }
    }
  } finally {
    if (timing && computing) timing.computeMs += performance.now() - started;
    if (!done) steps.return(undefined as never);
  }
}
