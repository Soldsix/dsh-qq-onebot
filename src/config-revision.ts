/** Stable revisions compare public operator settings, not credentials or runtime functions. */
import { createHash } from 'node:crypto'
import { CONFIG_FIELDS, isConfigKey, type Config } from './config-fields.ts'

/**
 * Hash the declared config fields in stable order, excluding runtime-only properties.
 * @param config - resolved public settings or the settings portion of a runtime spec.
 * @returns SHA-256 revision safe to show in an owner-only configuration page.
 */
export function configRevision(config: Config): string {
  return createHash('sha256').update(JSON.stringify(Object.keys(CONFIG_FIELDS).filter(isConfigKey).map(key => [key, config[key]]))).digest('hex')
}
