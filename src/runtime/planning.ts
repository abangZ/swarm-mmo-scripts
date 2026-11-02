export function finishPlanning<T>(steps: Generator<void, T>): T {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

export const yieldToPage = () => {
  const scheduler = (globalThis as typeof globalThis & { scheduler: { yield(): Promise<void> } }).scheduler;
  return scheduler.yield();
};

/** Keep one planner/executor, but let rendering and stop/configuration events run. */
export async function runPlanning<T>(steps: Generator<void, T>, current: () => boolean, resume = () => {}, yieldTask = yieldToPage, sliceMs = 8): Promise<T | undefined> {
  let done = false;
  let deadline = performance.now() + sliceMs;
  try {
    while (current()) {
      const step = steps.next();
      if (step.done) { done = true; return step.value; }
      if (performance.now() >= deadline) {
        await yieldTask();
        if (!current()) return;
        resume();
        deadline = performance.now() + sliceMs;
      }
    }
  } finally {
    if (!done) steps.return(undefined as never);
  }
}
