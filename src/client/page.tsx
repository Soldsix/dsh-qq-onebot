/** Native plugin configuration form; polling retains drafts and failed queries retain data. */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Button, Input, Switch, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { CONFIG_FIELDS, isConfigKey, type ConfigKey } from '../config-fields.ts'
import type { ControlSnapshot, ControlFailure, SaveRequest, RestartRequest } from '../control-types.ts'
import { draftPatch, fieldValue, type FormDraft } from '../config-draft.ts'

/** Sanitized browser operation failure, never a raw host diagnostic. */
export class PageProblem extends Error {
  constructor(readonly reason: ControlFailure | 'unavailable', readonly field?: ConfigKey) { super(reason) }
}

/** Business operations injected into the native plugin page. */
export interface PageFace {
  readonly read: () => Promise<ControlSnapshot>
  readonly save: (request: SaveRequest) => Promise<ControlSnapshot>
  readonly restart: (request: RestartRequest) => Promise<ControlSnapshot>
  readonly notify: (text: string, success: boolean) => void
}

/** Slot-owned properties, localized copy and business actions. */
export type PageProps = PropsRuntime<'plugins.bundle.config'> & PropsLocale<'qqOnebot'> & PageFace

/** Toast state outlives navigation away from the configuration page. */
export interface Notice { readonly id: number; readonly text: string; readonly success: boolean }

/** App-wide feedback source and its explicit dismissal operation. */
export interface NoticeFace {
  readonly hooks: { readonly notice: HostObservable<Notice | null> }
  readonly dismiss: (id: number) => void
}

/**
 * Render transient save/restart feedback outside the page's lifetime.
 * @param props - shared notice source and dismissal action.
 * @returns a native body-portal toast or no output.
 */
export function NoticeHost({ useNotice, dismiss }: InjectFace<NoticeFace>): ReactNode {
  const notice = useNotice(value => value)
  return notice ? <Toast key={notice.id} text={notice.text} {...notice.success ? { tone: 'success' as const } : {}} onDone={() => dismiss(notice.id)} /> : null
}

/**
 * Edit declared settings and read independent runtime evidence.
 * @param props - slot owner, locale and injected owner-only operations.
 * @returns the native bundle form; summary slots render no extra content.
 */
export function OneBotPage({ view, t, read, save, restart, notify }: PageProps): ReactNode {
  return view === 'page' ? <ConfigurationPage t={t} read={read} save={save} restart={restart} notify={notify} /> : null
}

function ConfigurationPage({ t, read, save, restart, notify }: PropsLocale<'qqOnebot'> & PageFace): ReactNode {
  const id = useId()
  const [snapshot, setSnapshot] = useState<ControlSnapshot | null>(null)
  const [baseline, setBaseline] = useState<ControlSnapshot | null>(null)
  const [draft, setDraft] = useState<FormDraft>({})
  const [queryFailed, setQueryFailed] = useState(false)
  const [reading, setReading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [invalid, setInvalid] = useState<ConfigKey | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const editing = useRef(false), writing = useRef(false), sequence = useRef(0), mounted = useRef(true)
  const patch = baseline ? draftPatch(draft, baseline.config) : null
  const dirty = patch?.ok === false || (patch?.ok === true && Object.keys(patch.patch).length > 0)
  editing.current = dirty

  function accept(next: ControlSnapshot, reset: boolean): void {
    setSnapshot(next)
    if (reset || (!editing.current && !writing.current)) { setBaseline(next); setDraft({}); setInvalid(null) }
  }

  useEffect(() => {
    mounted.current = true
    let live = true, timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      const revision = ++sequence.current
      setReading(true)
      let interval: number | undefined
      try {
        const next = await read()
        interval = next.refreshMs
        if (live && revision === sequence.current) { accept(next, false); setQueryFailed(false) }
      } catch (error) { if (live && revision === sequence.current) setQueryFailed(true) }
      finally { if (live && revision === sequence.current) setReading(false) }
      if (live && interval !== undefined) timer = setTimeout(() => { void poll() }, interval)
    }
    void poll()
    return () => { live = false; mounted.current = false; sequence.current++; clearTimeout(timer) }
  }, [read, refreshKey])

  const problemText = (error: unknown) => error instanceof PageProblem && error.reason !== 'unavailable' ? t(`failure.${error.reason}`) : t('unavailable')

  function refresh(): void { setRefreshKey(value => value + 1) }

  async function write(kind: 'save' | 'restart'): Promise<void> {
    if (writing.current || !baseline || !patch?.ok) return
    writing.current = true; sequence.current++; setBusy(true); setInvalid(null)
    try {
      const next = kind === 'save' ? await save({ revision: baseline.revision, patch: patch.patch }) : await restart({ revision: baseline.revision })
      notify(t(kind === 'save' ? 'saved' : 'restarted'), true)
      sequence.current++
      if (mounted.current) { accept(next, true); setQueryFailed(false) }
    } catch (error) {
      notify(problemText(error), false)
      if (mounted.current && error instanceof PageProblem) setInvalid(error.field ?? null)
    } finally { writing.current = false; if (mounted.current) setBusy(false) }
  }

  if (!snapshot || !baseline) return <section className="qqob-page">
    {queryFailed ? <div role="alert"><p>{t('loadFailed')}</p><Button onClick={() => { void refresh() }} disabled={reading}>{t('refresh')}</Button></div> : <span className="qqob-spinner" role="status" aria-label={t('loading')} />}
  </section>

  const activeConfig = baseline.config
  const mode = draft.mode ?? activeConfig.mode
  const fieldError = patch?.ok === false ? patch.field : invalid
  const renderField = (key: ConfigKey) => {
    const field = CONFIG_FIELDS[key], label = t(`field.${key}`), inputId = `${id}-${key}`, value = draft[key] ?? fieldValue(activeConfig, key)
    const change = (next: string | boolean) => { setDraft(previous => ({ ...previous, [key]: next })); setInvalid(null) }
    const error = fieldError === key
    return <div key={key} className="qqob-field">
      {field.kind === 'boolean' ? <span>{label}</span> : <label htmlFor={inputId}>{label}</label>}
      {field.kind === 'boolean' ? <Switch label={label} checked={value === true} disabled={busy} onChange={change} /> : field.kind === 'mode' || field.kind === 'host' ? <select id={inputId} value={String(value)} disabled={busy} onChange={event => change(event.currentTarget.value)} aria-invalid={error}>
        {field.kind === 'mode' ? <><option value="forward">{t('forward')}</option><option value="reverse">{t('reverse')}</option></> : <><option value="127.0.0.1">127.0.0.1</option><option value="::1">::1</option></>}
      </select> : <Input id={inputId} type={field.kind === 'number' ? 'number' : 'text'} value={String(value)} disabled={busy} spellCheck={false} autoComplete="off" onChange={event => change(event.currentTarget.value)} aria-invalid={error} aria-describedby={error ? `${inputId}-error` : undefined} />}
      {error && <span id={`${inputId}-error`} className="qqob-field-error" role="alert">{t('failure.config-invalid')}</span>}
    </div>
  }
  const keys = Object.keys(CONFIG_FIELDS).filter(isConfigKey)
  const runtime = snapshot.status
  return <form className="qqob-page" onSubmit={event => { event.preventDefault(); void write('save') }}>
    <p className="qqob-description">{t('intro')}</p>
    <section className="qqob-status" aria-live="polite">
      <strong>{!snapshot.config.enabled ? t('disabled') : snapshot.appliedRevision === snapshot.revision ? t('applied') : t('notApplied')}</strong>
      <dl>{(['active', 'socket', 'identity', 'online'] as const).map((key, index) => <div key={key}><dt>{t(key)}</dt><dd>{[snapshot.entryActive, runtime?.connected, runtime?.verified, runtime?.online][index] ? t('yes') : t('no')}</dd></div>)}</dl>
      <p>{t(`credential.${snapshot.credential}`)}</p>
      {runtime && <p>{t('phase')}: {t(`phase.${runtime.phase}`)}</p>}
      {runtime?.fault && <p>{t('fault', { code: runtime.fault })}</p>}
      {runtime && <p>{t('counts', { received: runtime.received, duplicates: runtime.duplicates, rejected: runtime.rejected, active: runtime.activeDeliveries })}</p>}
    </section>
    {queryFailed && <p className="qqob-query-error" role="alert">{t('loadFailed')}</p>}
    {dirty && <p className="qqob-draft" role="status">{snapshot.revision !== baseline.revision ? t('stale') : t('dirty')}</p>}
    <fieldset disabled={busy}><legend>{t('connection')}</legend>
      {keys.filter(key => CONFIG_FIELDS[key].section === 'connection' && (mode === 'forward' ? !['reverseHost', 'reversePort', 'reversePath'].includes(key) : key !== 'forwardUrl')).map(renderField)}
      <p className="qqob-help">{t('credentialHelp')}</p>
    </fieldset>
    <fieldset disabled={busy}><legend>{t('access')}</legend>{keys.filter(key => CONFIG_FIELDS[key].section === 'access').map(renderField)}<p className="qqob-help">{t('accessHelp')}</p></fieldset>
    <details><summary>{t('advanced')}</summary><fieldset disabled={busy}>{keys.filter(key => CONFIG_FIELDS[key].section === 'advanced').map(renderField)}</fieldset></details>
    {snapshot.overriddenFields.length > 0 && <p className="qqob-help">{t('overridden', { fields: snapshot.overriddenFields.map(key => t(`field.${key}`)).join(', ') })}</p>}
    <div className="qqob-actions">
      <Button type="submit" variant="primary" disabled={busy || !dirty || patch?.ok === false}>{t('save')}</Button>
      <Button type="button" variant="outline" disabled={busy || dirty || !snapshot.config.enabled || snapshot.entryDisabled} onClick={() => { void write('restart') }}>{t('restart')}</Button>
      <Button type="button" disabled={reading || busy} onClick={() => { void refresh() }}>{t('refresh')}</Button>
      <Button type="button" disabled={busy || !dirty} onClick={() => { accept(snapshot, true) }}>{t('discard')}</Button>
    </div>
    <p className="qqob-help">{t('restartHelp')}</p>
  </form>
}
