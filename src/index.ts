/** DSH bundle entry for one independently configured OneBot account. */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { ImRuntime } from 'dsh-im-kit'
import type {} from 'dsh-im-kit/cordis'
import { resolveConfig, type Config } from './config.ts'
import { OneBotTransport, type OneBotStatus } from './transport.ts'

/** Stable plugin identity used by settings and credential ownership. */
export const name = 'qq-onebot'
/** Secrets are resolved by DSH rather than duplicated in plugin settings. */
export const inject = ['credentials']
export { Config, resolveConfig, type Spec, type CredentialReader } from './config.ts'
export { OneBotTransport, type OneBotStatus } from './transport.ts'
export type { MediaSource } from './wire.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-only media and connection operations for the selected QQ account. */
    readonly qqOnebot: OneBotTransport
  }
  interface Events {
    /**
     * Sanitized transport state; observers cannot infer successful QQ delivery.
     * @param status - current account, capacity and health facts without secrets.
     * @mode emit
     */
    'qq-onebot/status'(status: OneBotStatus): void
  }
}

/**
 * Mount one account and its messaging service in the owning DSH profile.
 * @param ctx - Cordis context with DSH credentials.
 * @param config - schema-validated operator configuration.
 * @returns completion of reverse-listener startup or forward-loop initiation.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!config.enabled) return
  const spec = resolveConfig(config, {}, async reference => (await ctx.credentials.resolve(credentialRef(reference)))?.value)
  if (!spec) return
  try { await spec.accessToken() } catch (error) { throw new Error('OneBot credential lookup failed; check the configured DSH credential reference') }
  const runtime = new ImRuntime()
  ctx.effect(() => () => runtime.close())
  ctx.effect(() => ctx.provide('im', runtime))
  const transport = new OneBotTransport(spec, {
    async message(message, signal) {
      const report = await runtime.publish(message, signal)
      if (report.failed > 0) throw new Error('OneBot message consumer failed')
    },
    status: status => ctx.emit('qq-onebot/status', status),
  })
  ctx.effect(() => runtime.register(transport))
  ctx.effect(() => ctx.provide('qqOnebot', transport))
  await transport.start()
}
