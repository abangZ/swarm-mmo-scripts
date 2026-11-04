import type { Assignment, ExpansionSettings } from './types';
import type { ExpansionWorld } from './world';
import { Commander, idleState } from '../commander/engine';
import { defaultPolicy } from '../commander/types';
import type { AttackDiagnostics } from '../attack/diagnostics';
import type { SourceReport } from './proposals';
import type { StrategyMetrics } from './strategy';

export type ExpansionActivity = 'idle' | 'starting' | 'scanning' | 'waiting' | 'queued' | 'sending' | 'sent' | 'captured' | 'paused' | 'stopping' | 'stopped' | 'error';
export interface ExpansionState {
  activity: ExpansionActivity; ownedCount: number; candidateCount: number; lastScanAt: number | null; nextScanAt: number | null;
  running: boolean; phase: string; queue: Assignment[]; flights: number; sent: number; captured: number; missed: number; exact: boolean;
  diagnostics?: import('./world').WorldDiagnostics;
  logistics?: import('./logistics').LogisticsState[];
  meteorites?: import('./meteorite-frontier').MeteoriteReport[];
  work?: { planningTiming?: import('../../runtime/planning').PlanningTiming; frontierTiming?: import('../../runtime/planning').PlanningTiming; logisticsMs?: number; logisticsRoutes?: number; logisticsReused?: number; scanning?: boolean; plan?: { startedAt: number; stage: string; completed?: number; total?: number }; frontier?: number; dispatch?: string; background?: number; inventory?: number };
  rally?: { hub: bigint; target: bigint; required: number; available: number; incoming: number; sources: number };
  rallies?: NonNullable<ExpansionState['rally']>[];
  attackDiagnostics?: AttackDiagnostics;
  planning?: { sources: number; ready: number; assigned: number; idle: SourceReport[] };
  metrics?: StrategyMetrics; decisions?: string[]; exposed?: number;
  sun?: { target: bigint; hub?: bigint; waiting?: string };
}
/** Compatibility facade; all execution is owned by the shared commander. */
export class ExpansionEngine {
  state = idleState();
  private commander: Commander;
  constructor(update: (state: ExpansionState) => void, createWorld: () => ExpansionWorld) {
    this.commander = new Commander((_mode, state) => { this.state = state; update(state); }, createWorld);
  }
  get running() { return this.state.running; }
  start(settings: ExpansionSettings) { return this.commander.start('expansion', { settings, policy: { ...defaultPolicy } }); }
  stop() { this.commander.stop('expansion'); }
}
