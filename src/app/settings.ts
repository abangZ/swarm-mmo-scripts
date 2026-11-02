import { defaults, scanIntervals, validateSettings, type ExpansionSettings } from '../features/expansion/types';

const storageKey = 'swarm-helper-expansion-settings';
const timeKeys = new Set<keyof ExpansionSettings>(['scanMs', 'intervalMs', 'horizonMs', 'maxTravelMs', 'economicHorizonMs', 'stableMs']);
export const settingKeys = Object.keys(defaults) as (keyof ExpansionSettings)[];
export type SettingsForm = Record<keyof ExpansionSettings, string>;

export function toForm(settings: ExpansionSettings): SettingsForm {
  return Object.fromEntries(settingKeys.map(key => [key, String(settings[key] / (timeKeys.has(key) ? 1000 : 1))])) as SettingsForm;
}
export function loadSettings(key = storageKey): SettingsForm {
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (stored) {
      const saved = { ...defaults, ...stored };
      saved.maxSources ??= defaults.maxSources;
      saved.maxTravelMs ??= defaults.maxTravelMs;
      if (!scanIntervals.some(interval => interval === saved.scanMs)) saved.scanMs = defaults.scanMs;
      validateSettings(saved);
      return toForm(saved);
    }
  } catch { /* Invalid or unavailable storage falls back to defaults. */ }
  return toForm(defaults);
}
export function parseSettings(form: SettingsForm): ExpansionSettings {
  if (settingKeys.some(key => !form[key].trim())) throw new Error('请填写完整的运行参数。');
  const settings = Object.fromEntries(settingKeys.map(key => [key, Number(form[key]) * (timeKeys.has(key) ? 1000 : 1)])) as unknown as ExpansionSettings;
  validateSettings(settings);
  return settings;
}
export function saveSettings(form: SettingsForm, key = storageKey): ExpansionSettings {
  const settings = parseSettings(form);
  localStorage.setItem(key, JSON.stringify(settings));
  return settings;
}
