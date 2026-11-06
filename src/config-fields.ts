/** Client-safe configuration fields; credential values never enter this model. */

/** Operator-controlled transport and resource limits. */
export interface Config {
  enabled: boolean
  mode: 'forward' | 'reverse'
  tenantId: string
  accountId: string
  forwardUrl: string
  reverseHost: '127.0.0.1' | '::1'
  reversePort: number
  reversePath: string
  accessTokenEnv: string
  allowedGroups: string[]
  allowPrivate: boolean
  privateUsers: string[]
  connectTimeoutMs: number
  actionTimeoutMs: number
  healthIntervalMs: number
  healthTimeoutMs: number
  onlineStaleMs: number
  reconnectMinMs: number
  reconnectMaxMs: number
  shutdownTimeoutMs: number
  membershipCacheMs: number
  maxPendingActions: number
  maxFrameBytes: number
  maxBufferedBytes: number
  maxSegments: number
  maxTextChars: number
  maxReferences: number
  maxPendingMessages: number
  maxQueuedMessageBytes: number
  maxReferenceBytes: number
  maxMediaBytes: number
  maxStoredMediaBytes: number
  referenceTtlMs: number
}

/** Complete editable field registry, shared by wire validation and the native page. */
export const CONFIG_FIELDS = {
  enabled: { kind: 'boolean', section: 'connection' },
  mode: { kind: 'mode', section: 'connection' },
  tenantId: { kind: 'text', section: 'connection' },
  accountId: { kind: 'text', section: 'connection' },
  forwardUrl: { kind: 'text', section: 'connection' },
  reverseHost: { kind: 'host', section: 'connection' },
  reversePort: { kind: 'number', section: 'connection' },
  reversePath: { kind: 'text', section: 'connection' },
  accessTokenEnv: { kind: 'text', section: 'connection' },
  allowedGroups: { kind: 'list', section: 'access' },
  allowPrivate: { kind: 'boolean', section: 'access' },
  privateUsers: { kind: 'list', section: 'access' },
  connectTimeoutMs: { kind: 'number', section: 'advanced' },
  actionTimeoutMs: { kind: 'number', section: 'advanced' },
  healthIntervalMs: { kind: 'number', section: 'advanced' },
  healthTimeoutMs: { kind: 'number', section: 'advanced' },
  onlineStaleMs: { kind: 'number', section: 'advanced' },
  reconnectMinMs: { kind: 'number', section: 'advanced' },
  reconnectMaxMs: { kind: 'number', section: 'advanced' },
  shutdownTimeoutMs: { kind: 'number', section: 'advanced' },
  membershipCacheMs: { kind: 'number', section: 'advanced' },
  maxPendingActions: { kind: 'number', section: 'advanced' },
  maxFrameBytes: { kind: 'number', section: 'advanced' },
  maxBufferedBytes: { kind: 'number', section: 'advanced' },
  maxSegments: { kind: 'number', section: 'advanced' },
  maxTextChars: { kind: 'number', section: 'advanced' },
  maxReferences: { kind: 'number', section: 'advanced' },
  maxPendingMessages: { kind: 'number', section: 'advanced' },
  maxQueuedMessageBytes: { kind: 'number', section: 'advanced' },
  maxReferenceBytes: { kind: 'number', section: 'advanced' },
  maxMediaBytes: { kind: 'number', section: 'advanced' },
  maxStoredMediaBytes: { kind: 'number', section: 'advanced' },
  referenceTtlMs: { kind: 'number', section: 'advanced' },
} as const satisfies Record<keyof Config, { readonly kind: string; readonly section: string }>

/** Editable keys, with no runtime state or secret fields. */
export type ConfigKey = keyof Config

/**
 * Check a JSON field name against the complete public field registry.
 * @param value - external property name.
 * @returns whether the field belongs to this plugin's operator configuration.
 */
export function isConfigKey(value: string): value is ConfigKey { return Object.hasOwn(CONFIG_FIELDS, value) }
