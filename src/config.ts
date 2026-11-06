/** Validated deployment settings; disabled installations open no connections. */
import z from '@deepseek-ai/schemastery'
import { identifier, type AccountRef } from 'dsh-im-kit'

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

/** Profile configuration projected by DSH into its generated settings form. */
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
  if (!/^[1-9][0-9]*$/.test(config.accountId) || !Number.isSafeInteger(Number(config.accountId))) throw new Error('A canonical safe-integer accountId is required')
  for (const id of [...config.allowedGroups, ...config.privateUsers]) {
    if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error('Conversation allowlists require canonical safe-integer IDs')
  }
  if (new Set(config.allowedGroups).size !== config.allowedGroups.length || new Set(config.privateUsers).size !== config.privateUsers.length) {
    throw new Error('Conversation allowlists contain duplicate IDs')
  }
  if (config.reconnectMaxMs < config.reconnectMinMs) throw new Error('reconnectMaxMs must cover reconnectMinMs')
  if (config.maxStoredMediaBytes < config.maxMediaBytes) throw new Error('maxStoredMediaBytes must cover maxMediaBytes')
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.accessTokenEnv)) throw new Error('accessTokenEnv must name an environment variable')
  const validateToken = (value: string | undefined): string => {
    if (!value) throw new Error('Configured OneBot access-token reference is empty')
    if (/[\u0000-\u0020\u007f]/.test(value)) throw new Error('OneBot access token contains invalid header characters')
    return value
  }
  if (!readCredential) validateToken(env[config.accessTokenEnv])
  const endpoint = new URL(config.forwardUrl)
  if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Forward endpoint requires ws/wss without embedded credentials, query or fragment')
  }
  if (endpoint.protocol === 'ws:' && !['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)) {
    throw new Error('Remote forward endpoints require wss')
  }
  if (!config.reversePath.startsWith('/') || /[?#\s]/.test(config.reversePath)) throw new Error('reversePath must be an absolute path without query or fragment')
  return {
    ...config, accessToken: async () => validateToken(readCredential ? await readCredential(config.accessTokenEnv) : env[config.accessTokenEnv]),
    account: {
      tenantId: identifier('im.tenant', config.tenantId),
      networkId: identifier('im.network', 'onebot11'),
      accountId: identifier('im.account', config.accountId),
    },
  }
}
