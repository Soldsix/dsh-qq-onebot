/** Owner-only native configuration control, mounted separately from the transport. */
import { type Context } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-config-editor'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { Remote, RemoteError, TypertRemoteService, principalOf } from '@deepseek-ai/dsh-typert-protocol'
import { Config as TransportConfig, ConfigIssue, validateConfig } from './config.ts'
import { CONFIG_FIELDS, isConfigKey, type ConfigKey, type Config as TransportSettings } from './config-fields.ts'
import { configRevision } from './config-revision.ts'
import { isRecord } from './wire.ts'
import { waitFor } from './waiter.ts'
import type { ControlSnapshot, ControlFailure, SaveRequest } from './control-types.ts'
import type {} from './index.ts'

/** A controller can edit only its explicitly named transport entry. */
export interface ControlConfig { targetEntryId: string; statusRefreshMs: number }

/** Native bundle control settings; no connection or secret is duplicated here. */
export const Config: z<ControlConfig> = z.object({
  targetEntryId: z.string().default('qq-onebot-transport'),
  statusRefreshMs: z.number().min(250).max(60000).step(1).default(3000),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Trusted owner operations; no LLM tool is registered by this service. */
    readonly qqOnebotControl: OneBotControl
  }
}

function failure(reason: ControlFailure, field?: ConfigKey): RemoteError<'qq-onebot/control'> {
  return new RemoteError('qq-onebot/control', 'OneBot control operation could not complete', { reason, ...(field === undefined ? {} : { field }) })
}

function parseSettings(value: unknown): TransportSettings {
  try {
    if (!isRecord(value) || Object.keys(value).some(key => !isConfigKey(key))) throw failure('config-invalid')
    const config: TransportSettings = z.resolve(value, TransportConfig, {})[0]
    validateConfig(config)
    return config
  } catch (error) { throw failure('config-invalid', error instanceof ConfigIssue ? error.field : undefined) }
}

function revisionFrom(value: unknown): string {
  if (!isRecord(value) || typeof value['revision'] !== 'string' || !/^[a-f0-9]{64}$/.test(value['revision'])) throw failure('request-invalid')
  return value['revision']
}

function saveFrom(value: unknown): SaveRequest {
  const revision = revisionFrom(value)
  if (!isRecord(value) || Object.keys(value).some(key => key !== 'revision' && key !== 'patch') || !isRecord(value['patch'])) throw failure('request-invalid')
  const patch = value['patch']
  for (const [key, item] of Object.entries(patch)) {
    if (!isConfigKey(key)) throw failure('request-invalid')
    const kind = CONFIG_FIELDS[key].kind
    if (kind === 'boolean' ? typeof item !== 'boolean' : kind === 'number' ? !Number.isSafeInteger(item) : kind === 'list' ? !Array.isArray(item) || !item.every(value => typeof value === 'string') : typeof item !== 'string') throw failure('config-invalid', key)
  }
  // The registry check admits only declared fields; schema and cross-field checks run on the merged config.
  return { revision, patch: patch as Partial<TransportSettings> }
}

/** Ordinary settings use DSH's transactional profile editor and normal Cordis lifecycle. */
export class OneBotControl extends TypertRemoteService {
  static inject = ['configEditor', 'credentials']
  static Config = Config
  private readonly lifetime = new AbortController()
  private tail: Promise<void> = Promise.resolve()

  constructor(ctx: Context, private readonly config: ControlConfig) {
    super(ctx, 'qqOnebotControl')
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(config.targetEntryId)) throw new Error('targetEntryId must be a profile entry identifier')
    ctx.effect(() => async () => { this.lifetime.abort(); await this.tail })
  }

  private owner(): void {
    if (principalOf(this.ctx.invocation)) throw failure('forbidden')
    if (this.lifetime.signal.aborted || this.ctx.invocation?.signal.aborted) throw failure('cancelled')
  }

  private target(): Entry {
    const entries = this.ctx.configEditor.entries()
    const entry = entries.find(value => value.options.id === this.config.targetEntryId)
    if (!entry || entry.options.name !== 'dsh-qq-onebot' || !entry.fiber || entries.some(value => value !== entry && value.options.name === 'dsh-qq-onebot')) throw failure('entry-unavailable')
    return entry
  }

  private settings(entry: Entry): TransportSettings { return parseSettings(entry.fiber?.effectiveConfig) }

  private async credential(config: TransportSettings): Promise<ControlSnapshot['credential']> {
    if (!config.accessTokenEnv) return 'missing'
    try {
      const result = await waitFor(this.ctx.credentials.describe(credentialRef(config.accessTokenEnv)), AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(config.connectTimeoutMs)]))
      return result.kind === 'cancelled' ? 'unavailable' : result.value.configured ? 'configured' : 'missing'
    } catch (error) { return 'unavailable' }
  }

  private async snapshot(): Promise<ControlSnapshot> {
    const entry = this.target(), config = this.settings(entry)
    const layers = this.ctx.configEditor.configuration().find(value => value.entry === entry)
    const transport = this.ctx.get('qqOnebot')
    return {
      config: structuredClone(config), revision: configRevision(config), appliedRevision: transport?.configRevision ?? null,
      entryActive: entry.fiber?.state === 2, entryDisabled: entry.disabled,
      status: transport?.status() ?? null, credential: await this.credential(config),
      overriddenFields: Object.keys(layers?.override ?? {}).filter(isConfigKey),
      refreshMs: this.config.statusRefreshMs,
    }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    this.owner()
    const task = this.tail.then(() => { if (this.lifetime.signal.aborted) throw failure('cancelled'); return operation() })
    this.tail = task.then(() => {}, () => {})
    return task
  }

  /**
   * Read public settings, reference presence and independent runtime state.
   * @returns a detached owner-only snapshot; no credential resolution occurs.
   */
  @Remote
  describe(): Promise<ControlSnapshot> { return this.serial(() => this.snapshot()) }

  /**
   * Validate and persist only changed operator fields, rejecting stale editors.
   * @param request - revision and field patch from the native configuration page.
   * @returns settings after profile reconciliation; online status remains separate.
   */
  @Remote
  save(request: unknown): Promise<ControlSnapshot> {
    this.owner()
    const edit = saveFrom(request)
    return this.serial(async () => {
      const entry = this.target(), current = this.settings(entry)
      if (configRevision(current) !== edit.revision) throw failure('revision-conflict')
      const candidate = parseSettings({ ...current, ...edit.patch })
      if (candidate.enabled) {
        const credential = await this.credential(candidate)
        if (credential !== 'configured') throw failure(credential === 'missing' ? 'credentials-missing' : 'credentials-unavailable')
      }
      try {
        await this.ctx.configEditor.edit(entry, raw => {
          if (configRevision(this.settings(entry)) !== edit.revision) throw failure('revision-conflict')
          return { ...raw, ...edit.patch }
        })
      } catch (error) {
        if (isRecord(error) && error['isDSHRemoteError'] === true && error['code'] === 'qq-onebot/control') throw error
        throw failure('apply-failed')
      }
      return this.snapshot()
    })
  }

  /**
   * Restart the current fiber without rewriting or reverting operator settings.
   * @param request - expected configuration revision; no unsaved fields are accepted.
   * @returns fresh runtime evidence after the normal awaited restart.
   */
  @Remote
  restart(request: unknown): Promise<ControlSnapshot> {
    this.owner()
    const revision = revisionFrom(request)
    if (!isRecord(request) || Object.keys(request).some(key => key !== 'revision')) throw failure('request-invalid')
    return this.serial(async () => {
      const entry = this.target(), current = this.settings(entry)
      if (configRevision(current) !== revision) throw failure('revision-conflict')
      if (!current.enabled || entry.disabled) throw failure('entry-unavailable')
      try { await entry.fiber?.restart() } catch (error) { throw failure('apply-failed') }
      return this.snapshot()
    })
  }
}

export default OneBotControl
