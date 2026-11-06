/** Browser-safe owner control DTOs, with no secret values or message contents. */
import type { Config, ConfigKey } from './config-fields.ts'
import type { OneBotStatus } from './status.ts'
import type {} from '@deepseek-ai/dsh-typert-protocol/types'

declare module '@deepseek-ai/dsh-typert-protocol/types' {
  interface RemoteErrorDetailsMap {
    /** Sanitized owner control failure; no raw config or secret value is returned. */
    'qq-onebot/control': { readonly reason: ControlFailure; readonly field?: ConfigKey }
  }
}

/** Fresh configuration and independent runtime evidence. */
export interface ControlSnapshot {
  readonly config: Config
  readonly revision: string
  readonly appliedRevision: string | null
  readonly entryActive: boolean
  readonly entryDisabled: boolean
  readonly status: OneBotStatus | null
  readonly credential: 'configured' | 'missing' | 'unavailable'
  readonly overriddenFields: readonly ConfigKey[]
  readonly refreshMs: number
}

/** Optimistic edit of the declared operator fields only. */
export interface SaveRequest {
  readonly revision: string
  readonly patch: Partial<Config>
}

/** Reconnect is explicit and uses the current saved config, not an unsaved form. */
export interface RestartRequest { readonly revision: string }

/** Stable failures are localized by the caller, without echoing profile values. */
export type ControlFailure = 'forbidden' | 'request-invalid' | 'config-invalid' | 'revision-conflict' | 'entry-unavailable' | 'credentials-missing' | 'credentials-unavailable' | 'apply-failed' | 'cancelled'
