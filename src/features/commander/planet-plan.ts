import type { ExpansionState } from '../expansion/engine';
import { sourceLabel, targetLabel, totalCount, type Assignment } from '../expansion/types';
import type { Mode } from './types';

const modes = { expansion: '扩张', attack: '进攻' };

function describeJob(id: bigint, mode: Mode, job: Assignment): string | undefined {
  const target = (job.targetKind ?? 'planet') === 'planet' && job.targetId === id;
  const member = job.sourceId === id ? job : job.support?.find(item => item.sourceId === id);
  if (!target && !member) return;
  if (job.kind === 'upgrade') return `本星升级，消耗 ${job.count} 探针`;
  const action = job.kind ? '补给' : mode === 'attack' ? '进攻' : '占领';
  if (member) return `派 ${member.count} 探针${action}${targetLabel(job)}`;
  return `${sourceLabel(job)} 派 ${totalCount(job)} 探针${action}本星`;
}

export function planetPlanLines(id: bigint, mode: Mode, state: ExpansionState, submitted: Iterable<Assignment>): string[] {
  const lines: string[] = [];
  if (state.confirming) {
    const action = describeJob(id, mode, state.confirming);
    if (action) lines.push(`等待发射回执 · ${action}`);
  }
  for (const job of state.queue) {
    if (state.confirming?.targetId === job.targetId) continue;
    const action = describeJob(id, mode, job);
    if (action) lines.push(`待执行 · ${action}`);
  }
  for (const job of submitted) {
    const action = describeJob(id, mode, job);
    if (action) lines.push(`已提交 · ${action}，待核实占领`);
  }
  for (const plan of state.logistics ?? []) {
    const target = plan.kind === 'planet' && plan.target === id;
    if (plan.hub !== id && !target) continue;
    const role = target ? `由中转星 #${plan.hub} 募兵占领本星` : `本星为${plan.kind === 'sun' ? '恒星' : '星球'} #${plan.target} 募兵`;
    lines.push(`${role} · ${plan.phase}（${plan.available}/${plan.required}）`);
  }
  for (const rally of state.rallies ?? (state.rally ? [state.rally] : [])) {
    if (rally.hub !== id && rally.target !== id) continue;
    const role = rally.hub === id ? `本星为进攻 #${rally.target} 集结` : `中转星 #${rally.hub} 正为进攻本星集结`;
    lines.push(`${role}（${rally.available}/${rally.required}）`);
  }
  const saving = state.saving;
  if (saving && (saving.sourceId === id || saving.targetId === id)) {
    lines.push(`#${saving.sourceId} 正为进攻 #${saving.targetId} 攒兵，需要 ${saving.count} 探针`);
  }
  if (!lines.length) {
    const idle = state.planning?.idle.find(report => report.sourceId === id);
    if (idle) lines.push(`上轮未派兵 · 可用 ${idle.available}，${idle.reason}`);
  }
  return lines.map(line => `${modes[mode]} · ${line}`);
}
