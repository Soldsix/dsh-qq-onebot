/** Pure native form editing; background status reads never overwrite an edited draft. */
import { CONFIG_FIELDS, isConfigKey, type Config, type ConfigKey } from './config-fields.ts'

/** Only fields the owner changed are sent to the Host. */
export type FormDraft = Partial<Record<ConfigKey, string | boolean>>

/** One local parse error remains beside the owning input. */
export type DraftResult = { readonly ok: true; readonly patch: Partial<Config> } | { readonly ok: false; readonly field: ConfigKey }

/**
 * Parse native form values without replacing unchanged profile expressions.
 * @param draft - strings and booleans changed by the owner.
 * @param baseline - configuration at the start of editing.
 * @returns a minimal JSON patch, or the first field that is not a whole number.
 */
export function draftPatch(draft: FormDraft, baseline: Config): DraftResult {
  const patch: Partial<Config> = {}
  for (const [key, raw] of Object.entries(draft)) {
    if (!isConfigKey(key)) continue
    const kind = CONFIG_FIELDS[key].kind
    let value: string | boolean | number | string[]
    if (kind === 'boolean') {
      if (typeof raw !== 'boolean') return { ok: false, field: key }
      value = raw
    } else {
      if (typeof raw !== 'string') return { ok: false, field: key }
      if (kind === 'number') {
        if (!raw.trim() || !Number.isSafeInteger(Number(raw))) return { ok: false, field: key }
        value = Number(raw)
      } else value = kind === 'list' ? raw.split(/[\s,，]+/u).filter(Boolean) : raw.trim()
    }
    if (JSON.stringify(value) !== JSON.stringify(baseline[key])) Object.assign(patch, { [key]: value })
  }
  return { ok: true, patch }
}

/**
 * Format a resolved value for the native control without changing the baseline.
 * @param config - last confirmed editing baseline.
 * @param key - declared configuration key.
 * @returns a checkbox boolean or input string.
 */
export function fieldValue(config: Config, key: ConfigKey): string | boolean {
  const value = config[key]
  return typeof value === 'boolean' ? value : Array.isArray(value) ? value.join(', ') : String(value)
}
