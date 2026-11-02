import { planningWorker, type PlanningRequest } from './planner-work';
const scope = globalThis as unknown as { postMessage(message: unknown): void; onmessage: ((event: MessageEvent<PlanningRequest>) => void) | null };
const receive = planningWorker(message => scope.postMessage(message));
scope.onmessage = event => receive(event.data);
