/** Validated deployment settings; disabled installations open no connections. */
import z from '@deepseek-ai/schemastery'
import { identifier, type AccountRef } from 'dsh-im-kit'
import type { Config as Settings, ConfigKey } from './config-fields.ts'

/** Profile schema output, shared structurally with the browser-safe settings. */
export interface Config extends Settings {}

/** Profile schema; the bundle's native page edits ordinary fields through ConfigEditor. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  mode: z.union([z.const('forward'), z.const('reverse')]).default('forward'),
  tenantId: z.string().default('qq'),
  accountId: z.string().default(''),
  forwardUrl: z.string().default('ws://127.0.0.1:3001'),
  reverseHost: z.union([z.const('127.0.0.1'), z.const('::1')]).default('127.0.0.1'),
  reversePort: z.number().min(0).max(65535).step(1).default(3002),
  reversePath: z.string().default('/onebot'),
  accessTokenEnv: z.string().default('ONEBOT_ACCESS_TOKEN'),
  allowedGroups: z.array(z.string()).default([]),
  allowPrivate: z.boolean().default(false),
  privateUsers: z.array(z.string()).default([]),
  connectTimeoutMs: z.number().min(50).max(120000).step(1).default(10000),
  actionTimeoutMs: z.number().min(20).max(300000).step(1).default(15000),
  healthIntervalMs: z.number().min(50).max(300000).step(1).default(5000),
  healthTimeoutMs: z.number().min(20).max(60000).step(1).default(5000),
  onlineStaleMs: z.number().min(100).max(600000).step(1).default(15000),
  reconnectMinMs: z.number().min(20).max(300000).step(1).default(1000),
  reconnectMaxMs: z.number().min(20).max(600000).step(1).default(30000),
  shutdownTimeoutMs: z.number().min(50).max(30000).step(1).default(5000),
  membershipCacheMs: z.number().min(0).max(60000).step(1).default(3000),
  maxPendingActions: z.number().min(1).max(4096).step(1).default(128),
  maxFrameBytes: z.number().min(1024).max(134217728).step(1).default(67108864),
  maxBufferedBytes: z.number().min(1024).max(268435456).step(1).default(67108864),
  maxSegments: z.number().min(1).max(4096).step(1).default(256),
  maxTextChars: z.number().min(1).max(1048576).step(1).default(65536),
  maxReferences: z.number().min(1).max(65536).step(1).default(512),
  maxForwardNodes: z.number().min(1).max(65536).step(1).default(512),
  maxForwardResources: z.number().min(1).max(65536).step(1).default(64),
  maxForwardDepth: z.number().min(1).max(64).step(1).default(8),
  maxForwardCalls: z.number().min(1).max(4096).step(1).default(8),
  maxPendingMessages: z.number().min(1).max(65536).step(1).default(512),
  maxQueuedMessageBytes: z.number().min(1024).max(536870912).step(1).default(67108864),
  maxReferenceBytes: z.number().min(1024).max(536870912).step(1).default(67108864),
  maxMediaBytes: z.number().min(1).max(134217728).step(1).default(33554432),
  maxStoredMediaBytes: z.number().min(1).max(536870912).step(1).default(134217728),
  referenceTtlMs: z.number().min(1).max(86400000).step(1).default(900000),
})

/** Enabled configuration with identity bound outside protocol payloads. */
export interface Spec extends Config {
  readonly account: AccountRef
  readonly accessToken: () => Promise<string>
}

/** Host credential service lookup; references, never values, live in profile configuration. */
export type CredentialReader = (reference: string) => Promise<string | undefined>

/** A field-level error that never embeds its value in diagnostics. */
export class ConfigIssue extends Error {
  constructor(readonly field: ConfigKey) { super(`Invalid OneBot configuration field: ${field}`) }
}

/**
 * Validate cross-field and endpoint settings without resolving credentials.
 * @param config - schema-parsed settings; disabled drafts may omit connection identity.
 * @throws ConfigIssue when a field or required enabled value is invalid.
 */
export function validateConfig(config: Config): void {
  const canonical = (id: string) => /^[1-9][0-9]*$/.test(id) && Number.isSafeInteger(Number(id))
  if ((config.enabled || config.accountId) && !canonical(config.accountId)) throw new ConfigIssue('accountId')
  for (const field of ['allowedGroups', 'privateUsers'] as const) {
    if (config[field].some(id => !canonical(id)) || new Set(config[field]).size !== config[field].length) throw new ConfigIssue(field)
  }
  try { identifier('im.tenant', config.tenantId) } catch (error) { throw new ConfigIssue('tenantId') }
  if (config.reconnectMaxMs < config.reconnectMinMs) throw new ConfigIssue('reconnectMaxMs')
  if (config.maxStoredMediaBytes < config.maxMediaBytes) throw new ConfigIssue('maxStoredMediaBytes')
  if ((config.enabled || config.accessTokenEnv) && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.accessTokenEnv)) throw new ConfigIssue('accessTokenEnv')
  if ((config.enabled && config.mode === 'forward') || config.forwardUrl) {
    let endpoint: URL
    try { endpoint = new URL(config.forwardUrl) } catch (error) { throw new ConfigIssue('forwardUrl') }
    if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new ConfigIssue('forwardUrl')
    if (endpoint.protocol === 'ws:' && !['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)) throw new ConfigIssue('forwardUrl')
  }
  if (((config.enabled && config.mode === 'reverse') || config.reversePath) && (!config.reversePath.startsWith('/') || /[?#\s]/.test(config.reversePath))) throw new ConfigIssue('reversePath')
}

/**
 * Resolve a validated config against an explicitly supplied environment.
 * @param config - schema-admitted operator settings.
 * @param env - credential source; tests pass a private environment object.
 * @param readCredential - optional host lookup, re-resolved for each connection handshake.
 * @returns null for a disabled provider, otherwise a complete runtime spec.
 * @throws Error for missing identity/credentials or unsafe endpoint settings.
 */
export function resolveConfig(config: Config, env: Readonly<Record<string, string | undefined>>, readCredential?: CredentialReader): Spec | null {
  if (!config.enabled) return null
  validateConfig(config)
  const validateToken = (value: string | undefined): string => {
    if (!value) throw new Error('Configured OneBot access-token reference is empty')
    if (/[\u0000-\u0020\u007f]/.test(value)) throw new Error('OneBot access token contains invalid header characters')
    return value
  }
  if (!readCredential) validateToken(env[config.accessTokenEnv])
  return {
    ...config, accessToken: async () => validateToken(readCredential ? await readCredential(config.accessTokenEnv) : env[config.accessTokenEnv]),
    account: {
      tenantId: identifier('im.tenant', config.tenantId),
      networkId: identifier('im.network', 'onebot11'),
      accountId: identifier('im.account', config.accountId),
    },
  }
}
