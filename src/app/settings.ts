import { defaults, scanIntervals, validateSettings, type ExpansionSettings } from '../features/expansion/types';

const storageKey = 'swarm-helper-expansion-settings';
const timeKeys = new Set<keyof ExpansionSettings>(['scanMs', 'intervalMs', 'horizonMs']);
export const settingKeys = Object.keys(defaults) as (keyof ExpansionSettings)[];
export type SettingsForm = Record<keyof ExpansionSettings, string>;

export function toForm(settings: ExpansionSettings): SettingsForm {
  return Object.fromEntries(settingKeys.map(key => [key, String(settings[key] / (timeKeys.has(key) ? 1000 : 1))])) as SettingsForm;
}
export function loadSettings(): SettingsForm {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (saved) {
      saved.maxSources ??= defaults.maxSources;
      if (!scanIntervals.some(interval => interval === saved.scanMs)) saved.scanMs = defaults.scanMs;
      validateSettings(saved);
      return toForm(saved);
    }
  } catch { /* Invalid or unavailable storage falls back to defaults. */ }
  return toForm(defaults);
}
export function saveSettings(form: SettingsForm): ExpansionSettings {
  const settings = Object.fromEntries(settingKeys.map(key => [key, Number(form[key]) * (timeKeys.has(key) ? 1000 : 1)])) as unknown as ExpansionSettings;
  validateSettings(settings);
  localStorage.setItem(storageKey, JSON.stringify(settings));
  return settings;
}
