/** Browser RPC validation, independent of Cordis services and connection lifetimes. */
import * as z from 'zod/mini'
import { CONFIG_FIELDS, type Config } from './config-fields.ts'
import type { ControlSnapshot, SaveRequest, RestartRequest } from './control-types.ts'

const integer = z.int()
const config = z.strictObject({
  enabled: z.boolean(), mode: z.enum(['forward', 'reverse']), tenantId: z.string(), accountId: z.string(),
  forwardUrl: z.string(), reverseHost: z.enum(['127.0.0.1', '::1']), reversePort: integer, reversePath: z.string(),
  accessTokenEnv: z.string(), allowedGroups: z.array(z.string()), allowPrivate: z.boolean(), privateUsers: z.array(z.string()),
  connectTimeoutMs: integer, actionTimeoutMs: integer, healthIntervalMs: integer, healthTimeoutMs: integer,
  onlineStaleMs: integer, reconnectMinMs: integer, reconnectMaxMs: integer, shutdownTimeoutMs: integer,
  membershipCacheMs: integer, maxPendingActions: integer, maxFrameBytes: integer, maxBufferedBytes: integer,
  maxSegments: integer, maxTextChars: integer, maxReferences: integer, maxPendingMessages: integer,
  maxForwardNodes: integer, maxForwardResources: integer, maxForwardDepth: integer,
  maxForwardCalls: integer,
  maxQueuedMessageBytes: integer, maxReferenceBytes: integer, maxMediaBytes: integer, maxStoredMediaBytes: integer,
  referenceTtlMs: integer,
} satisfies { [Key in keyof Config]: z.ZodMiniType<Config[Key]> })
const revision = z.string().check(z.regex(/^[a-f0-9]{64}$/))
const counter = z.int().check(z.nonnegative())

/** Owner edits carry no runtime values, credentials, or undeclared fields. */
export const saveSchema: z.ZodMiniType<SaveRequest> = z.strictObject({
  revision,
  patch: z.pipe(z.partial(config), z.transform(value => Object.fromEntries(Object.entries(value).filter(([,item]) => item !== undefined)) as Partial<Config>)),
})

/** Reconnection references the saved revision without changing configuration. */
export const restartSchema: z.ZodMiniType<RestartRequest> = z.strictObject({ revision })

/** Every status result is validated before it can enter the form state. */
export const snapshotSchema: z.ZodMiniType<ControlSnapshot> = z.strictObject({
  config, revision, appliedRevision: z.nullable(revision), entryActive: z.boolean(), entryDisabled: z.boolean(),
  credential: z.enum(['configured', 'missing', 'unavailable']),
  overriddenFields: z.array(z.enum(Object.keys(CONFIG_FIELDS) as [keyof Config, ...(keyof Config)[]])),
  refreshMs: z.int().check(z.minimum(250),z.maximum(60000)),
  status: z.nullable(z.strictObject({
    phase: z.enum(['connecting', 'verifying', 'online', 'offline', 'blocked', 'stopped']),
    connected: z.boolean(), verified: z.boolean(), online: z.boolean(), received: counter,
    duplicates: counter, rejected: counter, notices: counter, activeDeliveries: counter,
    storedReferences: counter, storedMediaBytes: counter, fault: z.nullable(z.string()),
  })),
})
