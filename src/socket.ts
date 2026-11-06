/** Authenticated OneBot WebSocket sessions with bounded, non-retrying RPC calls. */
import { createServer, type Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { inspect } from 'node:util'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import type { Spec } from './config.ts'
import { isRecord } from './wire.ts'
import { waitFor } from './waiter.ts'

/** Transport result; an uncertain action must never be blindly repeated. */
export type ActionResult =
  | { readonly kind: 'ok'; readonly data: unknown }
  | { readonly kind: 'rejected'; readonly retcode: number }
  | { readonly kind: 'not-sent'; readonly code: 'offline' | 'cancelled' | 'busy' | 'too-large' | 'invalid' }
  | { readonly kind: 'uncertain'; readonly code: 'timeout' | 'cancelled' | 'closed' | 'send-error' }

/** Host callbacks never receive access tokens or request headers. */
export interface SocketHooks {
  readonly event: (value: unknown, bytes: number) => void
  readonly connection: (connected: boolean) => void
  readonly fault: (code: string) => void
  readonly stopped?: () => void
}

interface Session {
  readonly socket: WebSocket
  readonly done: Promise<void>
  finish: () => void
}

interface Pending {
  readonly finish: (result: ActionResult) => void
}

type RequestId = Branded<'onebot.rpc-request'>

/** One authenticated universal WebSocket peer; construction opens no connection. */
export class OneBotSocket {
  private readonly lifetime = new AbortController()
  private readonly pending = new Map<RequestId, Pending>()
  private readonly upgrades = new Set<Duplex>()
  private readonly admissions = new Set<Promise<void>>()
  private session: Session | undefined
  private forwardTask: Promise<void> | undefined
  private server: HttpServer | undefined
  private webSockets: WebSocketServer | undefined
  private closing: Promise<void> | undefined
  private started = false
  private suspended = false
  private faultCode: string | undefined

  readonly #spec: Spec
  readonly #hooks: SocketHooks

  constructor(spec: Spec, hooks: SocketHooks) { this.#spec = spec; this.#hooks = hooks }

  /** Whether the active peer has a live socket; this does not prove QQ login. */
  get connected(): boolean { return this.session?.socket.readyState === WebSocket.OPEN }

  /** Bound loopback port, including an OS-assigned port in isolated tests. */
  get port(): number | undefined {
    const address = this.server?.address()
    return address && typeof address !== 'string' ? address.port : undefined
  }

  /** A code only; raw socket errors may contain credential-bearing endpoints. */
  get lastFault(): string | undefined { return this.faultCode }

  /**
   * Start the configured forward loop or bind the reverse listener.
   * @returns readiness of the listener or initiation of the cancellable dial loop.
   * @throws Error for a reused/stopped instance or a failed reverse bind.
   */
  async start(): Promise<void> {
    if (this.started || this.lifetime.signal.aborted) throw new Error('OneBot socket cannot be started twice')
    this.started = true
    if (this.#spec.mode === 'forward') {
      this.forwardTask = this.forwardLoop().finally(() => {
        try { this.#hooks.stopped?.() } catch (error) { this.reportFault('stopped-listener-failed') }
      })
      void this.forwardTask.catch(() => { this.reportFault('forward-loop-failed') })
      return
    }
    await this.startReverse()
  }

  /**
   * Suspend reconnection after a verified identity or authentication refusal.
   * @param code - non-secret diagnostic code.
   */
  suspend(code: string): void {
    this.suspended = true
    this.reportFault(code)
    this.session?.socket.close(1008, 'Connection configuration requires review')
  }

  /**
   * Call one action once and correlate its response on this session only.
   * @param action - host-selected OneBot action.
   * @param params - host-built parameters.
   * @param signal - caller cancellation.
   * @returns explicit rejection, success, pre-send refusal, or uncertainty.
   */
  call(action: string, params: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<ActionResult> {
    const session = this.session
    if (signal.aborted || this.lifetime.signal.aborted) return Promise.resolve({ kind: 'not-sent', code: 'cancelled' })
    if (!session || session.socket.readyState !== WebSocket.OPEN || this.suspended) return Promise.resolve({ kind: 'not-sent', code: 'offline' })
    if (this.pending.size >= this.#spec.maxPendingActions) return Promise.resolve({ kind: 'not-sent', code: 'busy' })
    const echo = brandString<RequestId>(randomUUID())
    let payload: string
    try { payload = JSON.stringify({ action, params, echo }) } catch (error) {
      // No frame was queued when JSON encoding failed.
      return Promise.resolve({ kind: 'not-sent', code: 'invalid' })
    }
    if (Buffer.byteLength(payload) > this.#spec.maxFrameBytes) return Promise.resolve({ kind: 'not-sent', code: 'too-large' })
    if (session.socket.bufferedAmount + Buffer.byteLength(payload) > this.#spec.maxBufferedBytes) return Promise.resolve({ kind: 'not-sent', code: 'busy' })
    return new Promise(resolve => {
      let settled = false
      const finish = (result: ActionResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        this.pending.delete(echo)
        resolve(result)
      }
      const abort = (): void => finish({ kind: 'uncertain', code: 'cancelled' })
      const timer = setTimeout(() => finish({ kind: 'uncertain', code: 'timeout' }), this.#spec.actionTimeoutMs)
      signal.addEventListener('abort', abort, { once: true })
      this.pending.set(echo, { finish })
      try {
        session.socket.send(payload, error => {
          if (error) finish({ kind: 'uncertain', code: 'send-error' })
        })
      } catch (error) {
        // Once send has been called, an exception cannot certify non-delivery.
        finish({ kind: 'uncertain', code: 'send-error' })
      }
    })
  }

  /**
   * Detach frame dispatch, stop listeners, terminate peers and await all owned work.
   * @returns a stable completion promise.
   */
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closing = Promise.resolve().then(() => this.finishClose())
    this.lifetime.abort()
    this.session?.socket.removeAllListeners('message')
    for (const pending of this.pending.values()) pending.finish({ kind: 'uncertain', code: 'closed' })
    return this.closing
  }

  /** Return diagnostics without endpoints, request objects, or credentials. */
  toJSON(): { connected: boolean; listening: boolean; fault: string | null } {
    return { connected: this.connected, listening: this.port !== undefined, fault: this.lastFault ?? null }
  }

  /** Keep incidental debugger output subject to the same redaction. */
  [inspect.custom](): { connected: boolean; listening: boolean; fault: string | null } { return this.toJSON() }

  private reportFault(code: string): void {
    this.faultCode = code
    try { this.#hooks.fault(code) } catch (error) {
      // Diagnostics cannot break the transport dispatcher.
      this.faultCode = 'fault-listener-failed'
    }
  }

  private notifyConnection(connected: boolean): void {
    if (this.lifetime.signal.aborted) return
    try { this.#hooks.connection(connected) } catch (error) { this.reportFault('connection-listener-failed') }
  }

  private bind(socket: WebSocket): Session {
    let finish!: () => void
    const done = new Promise<void>(resolve => { finish = resolve })
    const session: Session = { socket, done, finish }
    this.session = session
    socket.on('message', (raw, binary) => {
      if (this.session !== session || this.lifetime.signal.aborted) return
      if (binary) { this.reportFault('binary-frame-rejected'); return }
      this.receive(raw)
    })
    socket.on('error', () => { if (!this.suspended) this.reportFault('socket-error') })
    socket.once('close', () => {
      if (this.session === session) {
        this.session = undefined
        for (const pending of this.pending.values()) pending.finish({ kind: 'uncertain', code: 'closed' })
        this.notifyConnection(false)
      }
      finish()
    })
    if (socket.readyState === WebSocket.OPEN) this.notifyConnection(true)
    else socket.once('open', () => {
      if (this.session === session && !this.lifetime.signal.aborted) this.notifyConnection(true)
    })
    return session
  }

  private receive(raw: RawData): void {
    let frame: unknown
    let bytes = 0
    try {
      const buffer = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      bytes = buffer.byteLength
      frame = JSON.parse(buffer.toString('utf8'))
    } catch (error) { this.reportFault('invalid-json'); return }
    if (isRecord(frame) && typeof frame.echo === 'string') {
      const request = this.pending.get(brandString<RequestId>(frame.echo))
      if (!request) return
      if (frame.status === 'ok' && frame.retcode === 0) request.finish({ kind: 'ok', data: frame.data })
      else if (frame.status === 'failed' && typeof frame.retcode === 'number') request.finish({ kind: 'rejected', retcode: frame.retcode })
      else this.reportFault('invalid-action-response')
      return
    }
    try { this.#hooks.event(frame, bytes) } catch (error) { this.reportFault('event-listener-failed') }
  }

  private async forwardLoop(): Promise<void> {
    let backoff = this.#spec.reconnectMinMs
    while (!this.lifetime.signal.aborted && !this.suspended) {
      const token = await this.handshakeToken()
      if (!token || this.lifetime.signal.aborted) return
      const socket = new WebSocket(this.#spec.forwardUrl, {
        headers: { Authorization: 'Bearer ' + token },
        handshakeTimeout: this.#spec.connectTimeoutMs,
        maxPayload: this.#spec.maxFrameBytes,
      })
      const session = this.bind(socket)
      let opened = false
      socket.once('open', () => { opened = true })
      socket.once('unexpected-response', (_request, response) => {
        if (response.statusCode === 401 || response.statusCode === 403) this.suspended = true
        this.reportFault(this.suspended ? 'authentication-rejected' : 'handshake-rejected')
        response.resume()
        socket.terminate()
      })
      await session.done
      if (this.lifetime.signal.aborted || this.suspended) return
      if (opened) backoff = this.#spec.reconnectMinMs
      try { await delay(backoff, undefined, { signal: this.lifetime.signal }) } catch (error) {
        if (!this.lifetime.signal.aborted) throw error
      }
      backoff = Math.min(this.#spec.reconnectMaxMs, backoff * 2)
    }
  }

  private async startReverse(): Promise<void> {
    const server = createServer((_request, response) => { response.writeHead(404); response.end() })
    const webSockets = new WebSocketServer({ noServer: true, maxPayload: this.#spec.maxFrameBytes })
    this.server = server
    this.webSockets = webSockets
    server.on('upgrade', (request, socket, head) => {
      if (this.admissions.size >= this.#spec.maxPendingActions || this.lifetime.signal.aborted) { socket.destroy(); return }
      this.upgrades.add(socket)
      const admit = async (): Promise<void> => {
      const token = await this.handshakeToken()
      if (!token || socket.destroyed || this.lifetime.signal.aborted) { socket.destroy(); return }
      const expected = Buffer.from('Bearer ' + token)
      const supplied = Buffer.from(request.headers.authorization ?? '')
      const role = request.headers['x-client-role']
      const identity = request.headers['x-self-id']
      const valid = request.url === this.#spec.reversePath && supplied.length === expected.length && timingSafeEqual(supplied, expected)
        && (identity === undefined || identity === this.#spec.accountId)
        && (role === undefined || role === 'Universal')
      if (!valid || this.lifetime.signal.aborted || this.suspended || this.session) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      webSockets.handleUpgrade(request, socket, head, peer => { this.bind(peer) })
      }
      const task = admit().catch(() => { this.reportFault('reverse-admission-failed'); socket.destroy() })
      this.admissions.add(task)
      void task.then(() => { this.admissions.delete(task); this.upgrades.delete(socket) })
    })
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error): void => { server.off('listening', ready); reject(error) }
      const ready = (): void => { server.off('error', failed); resolve() }
      server.once('error', failed)
      server.once('listening', ready)
      server.listen(this.#spec.reversePort, this.#spec.reverseHost)
    })
    server.on('error', () => { this.reportFault('reverse-listener-error') })
  }

  private async handshakeToken(): Promise<string | undefined> {
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.#spec.connectTimeoutMs)])
    try {
      const token = await waitFor(this.#spec.accessToken(), signal)
      if (token.kind === 'value') return token.value
      if (!this.lifetime.signal.aborted) this.reportFault('credential-timeout')
    } catch (error) { this.suspended = true; this.reportFault('credential-unavailable') }
    return undefined
  }

  private async stopSession(session: Session): Promise<void> {
    if (session.socket.readyState === WebSocket.CLOSED) return
    const timer = setTimeout(() => { session.socket.terminate() }, this.#spec.shutdownTimeoutMs)
    try {
      if (session.socket.readyState === WebSocket.CONNECTING) session.socket.terminate()
      else session.socket.close(1000, 'Stopping')
      await session.done
    } finally { clearTimeout(timer) }
  }

  private async finishClose(): Promise<void> {
    const session = this.session
    for (const socket of this.upgrades) socket.destroy()
    const closingServer = this.server && this.server.listening ? new Promise<void>((resolve, reject) => {
      this.server!.close(error => error ? reject(error) : resolve())
      this.server!.closeAllConnections()
    }) : Promise.resolve()
    const results = await Promise.allSettled([
      session ? this.stopSession(session) : Promise.resolve(),
      closingServer,
      this.webSockets ? new Promise<void>(resolve => this.webSockets!.close(() => resolve())) : Promise.resolve(),
      this.forwardTask,
      ...this.admissions,
    ])
    const failures: unknown[] = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'OneBot socket shutdown failed')
  }
}
