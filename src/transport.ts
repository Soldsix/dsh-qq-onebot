/** QQ identity verification, scoped media references and non-retrying message delivery. */
import { randomUUID } from 'node:crypto'
import { inspect } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import {
  identifier, messageKey, sameScope, type AccountRef, type AttachmentId, type Availability,
  type ConversationScope, type DeliveryReceipt, type ImTransport, type InboundMessage,
  type MessageId, type MessageKey, type MessagePart, type OutboundMessage, type ForwardId,
} from 'dsh-im-kit'
import type { Spec } from './config.ts'
import { OneBotSocket } from './socket.ts'
import { allowsScope, isRecord, parseMessage, wireId, type JsonRecord, type MediaSource, type ParsedMessage, type WireSegment } from './wire.ts'
import { waitFor } from './waiter.ts'
import { configRevision } from './config-revision.ts'
import type { OneBotStatus } from './status.ts'
import {parseForward,type ParsedForward} from './forward-wire.ts'
import type {OneBotForwardResult} from './forward-types.ts'
export type { OneBotStatus } from './status.ts'

/** Callbacks belong to the owning plugin; publishers must settle after cancellation. */
export interface TransportHooks {
  readonly message: (message: InboundMessage, signal: AbortSignal) => Promise<void>
  readonly status?: (status: OneBotStatus) => void
  readonly now?: () => number
}

interface StoredMessage { readonly parsed: ParsedMessage; bytes: number; expires: number; readonly forwardGrants:Set<ForwardId>; readonly forwards:Map<ForwardId,ParsedForward>; forwardNodes:number }
interface ForwardFlight{readonly root:MessageKey;readonly controller:AbortController;readonly done:Promise<OneBotForwardResult>;waiters:number}
interface StoredMedia { readonly scope: ConversationScope; readonly kind: 'image' | 'audio' | 'video' | 'file'; readonly bytes: Buffer; readonly name?: string; readonly expires: number }
interface Member { readonly role: 'member' | 'admin' | 'owner'; readonly until: number; readonly observedAt: number; readonly expires: number }
interface Mute { individual?: { readonly until: number; readonly at: number }; whole?: { readonly active: boolean; readonly at: number } }

/** One verified QQ account, with no model, persona or automatic reply behavior. */
export class OneBotTransport implements ImTransport {
  readonly account: AccountRef
  /** Revision of public settings applied to this transport instance. */
  readonly configRevision: string
  readonly #spec: Spec
  readonly #hooks: TransportHooks
  readonly #socket: OneBotSocket
  readonly #lifetime = new AbortController()
  readonly #messages = new Map<MessageKey, StoredMessage>()
  readonly #sources = new Map<AttachmentId, { readonly key: MessageKey; readonly source: MediaSource }>()
  readonly #media = new Map<AttachmentId, StoredMedia>()
  readonly #members = new Map<string, Member>()
  readonly #memberTasks = new Map<string, Promise<Member | null>>()
  readonly #mutes = new Map<string, Mute>()
  readonly #deliveries = new Set<Promise<void>>()
  readonly #activeMessages = new Set<MessageKey>()
  readonly #healthTasks = new Set<Promise<void>>()
  readonly #forwardCalls = new Map<string,ForwardFlight>()
  readonly #forwardTasks = new Set<Promise<OneBotForwardResult>>()
  readonly #forwardPins = new Map<MessageKey,number>()
  readonly #early: { readonly parsed: ParsedMessage; readonly bytes: number }[] = []
  #health: AbortController | undefined
  #phase: OneBotStatus['phase'] = 'connecting'
  #verified = false
  #admitted = false
  #online = false
  #lastProbe = 0
  #revision = 0
  #generation = 0
  #queuedBytes = 0
  #referenceBytes = 0
  #mediaBytes = 0
  #received = 0
  #rejected = 0
  #duplicates = 0
  #notices = 0
  #fault: string | null = null
  #closing: Promise<void> | undefined

  constructor(spec: Spec, hooks: TransportHooks) {
    this.account = spec.account
    this.configRevision = configRevision(spec)
    this.#spec = spec
    this.#hooks = hooks
    this.#socket = new OneBotSocket(spec, {
      connection: connected => this.connectionChanged(connected),
      event: (value, bytes) => this.receive(value, bytes),
      fault: code => {
        this.#fault = code
        if (code === 'authentication-rejected' || code.startsWith('credential-')) { this.#phase = 'blocked'; this.#online = false; this.#verified = false }
        this.emitStatus()
      },
    })
  }

  /** The reverse listener's assigned port, for host-only setup and isolated tests. */
  get port(): number | undefined { return this.#socket.port }

  /**
   * Start network admission without waiting for QQ login.
   * @returns reverse-listener readiness or forward-loop initiation.
   */
  start(): Promise<void> { return this.#socket.start() }

  /**
   * Read sanitized state and apply the configured online-evidence age limit.
   * @returns account state without endpoints, tokens, host paths or identities.
   */
  status(): OneBotStatus {
    const stale = this.#online && this.#verified && this.now() - this.#lastProbe > this.#spec.onlineStaleMs
    return {
      phase: stale && this.#phase === 'online' ? 'offline' : this.#phase, connected: this.#socket.connected, verified: this.#verified,
      online: this.#online && this.#verified && this.#socket.connected && !stale,
      received: this.#received, duplicates: this.#duplicates, rejected: this.#rejected, notices: this.#notices,
      activeDeliveries: this.#deliveries.size, storedReferences: this.#messages.size, storedMediaBytes: this.#mediaBytes, fault: this.#fault ?? (stale ? 'health-evidence-stale' : null),
    }
  }

  /**
   * Check destination policy and mute evidence before starting expensive work.
   * @param scope - exact target conversation.
   * @param signal - one waiter's lifetime, not the shared membership-query lifetime.
   * @returns readiness for this target; network state is independently available in status().
   */
  async availability(scope: ConversationScope, signal: AbortSignal): Promise<Availability> {
    if (signal.aborted || this.#lifetime.signal.aborted || !allowsScope(scope, this.#spec)) return 'disabled'
    if (!this.status().online) return 'offline'
    if (scope.kind === 'private') return 'available'
    const member = await waitFor(this.member(scope.peerId), signal)
    if (member.kind === 'cancelled' || this.#lifetime.signal.aborted) return 'disabled'
    if (!this.status().online || !member.value) return 'offline'
    const state = this.#mutes.get(scope.peerId)
    const until = state?.individual && state.individual.at >= member.value.observedAt ? state.individual.until : member.value.until
    if (until > this.now()) return 'muted'
    if (state?.whole?.active && member.value.role === 'member') return 'muted'
    return 'available'
  }

  /**
   * Send one standard message without regeneration or automatic transport retry.
   * @param message - exact destination and typed content.
   * @param signal - request lifetime.
   * @returns server acceptance, a definitive refusal, or uncertainty.
   */
  async send(message: OutboundMessage, signal: AbortSignal): Promise<DeliveryReceipt> {
    const availability = await this.availability(message.scope, signal)
    if (availability !== 'available') return { status: 'failed', code: availability }
    if (signal.aborted) return { status: 'failed', code: 'cancelled' }
    const encoded = this.encode(message.scope, message.parts)
    if (!encoded) return { status: 'failed', code: 'rejected' }
    const result = await this.#socket.call(message.scope.kind === 'group' ? 'send_group_msg' : 'send_private_msg', {
      [message.scope.kind === 'group' ? 'group_id' : 'user_id']: Number(message.scope.peerId), message: encoded,
    }, signal)
    if (result.kind === 'ok') {
      const id = isRecord(result.data) ? wireId(result.data.message_id) : null
      return id === null ? { status: 'uncertain', code: 'provider-error' } : { status: 'accepted', messageIds: [identifier('im.message', id)] }
    }
    if (result.kind === 'rejected') return { status: 'failed', code: result.retcode === 1403 || result.retcode === 403 ? 'permission-denied' : 'rejected' }
    if (result.kind === 'not-sent') return { status: 'failed', code: result.code === 'cancelled' ? 'cancelled' : result.code === 'offline' ? 'offline' : 'unavailable' }
    return { status: 'uncertain', code: result.code === 'timeout' ? 'timeout' : result.code === 'cancelled' ? 'cancelled-after-dispatch' : 'provider-error' }
  }

  /**
   * Retain outbound bytes under an opaque reference; the input is copied once.
   * @param scope - destination to which the reference is restricted.
   * @param kind - transport media type.
   * @param bytes - validated artifact bytes supplied by an authorized host consumer.
   * @param name - optional display filename.
   * @returns a new scope-bound attachment identity.
   * @throws Error for disallowed scope, capacity, empty content or unsafe filename.
   */
  registerMedia(scope: ConversationScope, kind: StoredMedia['kind'], bytes: Uint8Array, name?: string): AttachmentId {
    this.prune()
    if (this.#lifetime.signal.aborted || !allowsScope(scope, this.#spec)) throw new Error('Media destination is not admitted')
    if (bytes.byteLength === 0 || bytes.byteLength > this.#spec.maxMediaBytes || this.#mediaBytes + bytes.byteLength > this.#spec.maxStoredMediaBytes || this.#media.size >= this.#spec.maxReferences) throw new Error('Media capacity exceeded')
    if (name !== undefined && (!name || /[\\/:\u0000-\u001f\u007f]/.test(name))) throw new Error('Media name must be a filename')
    const id = identifier('im.attachment', randomUUID())
    this.#media.set(id, { scope, kind, bytes: Buffer.from(bytes), ...(name === undefined ? {} : { name }), expires: this.now() + this.#spec.referenceTtlMs })
    this.#mediaBytes += bytes.byteLength
    return id
  }

  /**
   * Release an outbound reference only from its destination scope.
   * @param scope - owning destination.
   * @param id - allocated media reference.
   * @returns whether owned bytes were released.
   */
  releaseMedia(scope: ConversationScope, id: AttachmentId): boolean {
    const media = this.#media.get(id)
    if (!media || !sameScope(media.scope, scope)) return false
    this.#media.delete(id); this.#mediaBytes -= media.bytes.byteLength
    return true
  }

  /**
   * Retrieve an incoming source without exposing it to another conversation.
   * @param scope - requesting conversation.
   * @param id - opaque reference from an admitted message.
   * @returns host-only source metadata or undefined after expiry or for another scope.
   */
  mediaSource(scope: ConversationScope, id: AttachmentId): MediaSource | undefined {
    this.prune()
    const source = this.#sources.get(id)
    return source && sameScope(source.source.scope, scope) ? structuredClone(source.source) : undefined
  }

  /**
   * Retrieve the exact admitted wire object for archive, quote or platform readers.
   * @param scope - original conversation.
   * @param id - transport message identity.
   * @returns an independent JSON snapshot, or undefined when not admitted or expired.
   */
  original(scope: ConversationScope, id: MessageId): JsonRecord | undefined {
    this.prune()
    const record = this.#messages.get(messageKey(scope, id))
    return record && allowsScope(scope, this.#spec) ? structuredClone(record.parsed.raw) : undefined
  }

  /**
   * Read only resources granted by a retained outer message or its resolved descendants.
   * @param scope - authenticated outer conversation; returned child metadata cannot change it.
   * @param rootMessageId - admitted outer message identity.
   * @param resourceId - resource from that message or a previously resolved child.
   * @param signal - one waiter's lifetime; shared calls stop when no waiters remain.
   * @returns detached normalized nodes or an explicit failure; no retry or inbound publication.
   */
  async readForward(scope:ConversationScope,rootMessageId:MessageId,resourceId:ForwardId,signal:AbortSignal):Promise<OneBotForwardResult>{
    if(signal.aborted||this.#lifetime.signal.aborted)return{status:'failed',code:'cancelled'}
    if(!allowsScope(scope,this.#spec))return{status:'failed',code:'permission-denied'}
    this.prune();const root=messageKey(scope,rootMessageId),record=this.#messages.get(root)
    if(!record||!record.forwardGrants.has(resourceId))return{status:'failed',code:'not-found'}
    const cached=record.forwards.get(resourceId)
    if(cached)return structuredClone({status:'resolved',scope:record.parsed.message.scope,rootMessageId,resourceId,nodes:cached.nodes,raw:cached.raw})
    if(!this.status().online)return{status:'failed',code:'offline'}
    const key=JSON.stringify([root,resourceId]);let flight=this.#forwardCalls.get(key)
    if(!flight){
      if(this.#forwardCalls.size>=this.#spec.maxForwardCalls)return{status:'failed',code:'capacity'}
      const controller=new AbortController();this.#forwardPins.set(root,(this.#forwardPins.get(root)??0)+1)
      const done=this.fetchForward(root,record,rootMessageId,resourceId,controller.signal),created:ForwardFlight={root,controller,done,waiters:0};flight=created;this.#forwardCalls.set(key,created);this.#forwardTasks.add(done)
      const finish=():void=>{this.#forwardTasks.delete(done);if(this.#forwardCalls.get(key)===created)this.#forwardCalls.delete(key);const pins=(this.#forwardPins.get(root)??1)-1;if(pins)this.#forwardPins.set(root,pins);else this.#forwardPins.delete(root);this.prune()}
      void done.then(finish,finish)
    }
    flight.waiters++
    try{const result=await waitFor(flight.done,signal);return result.kind==='cancelled'?{status:'failed',code:'cancelled'}:structuredClone(result.value)}
    finally{if(--flight.waiters===0){flight.controller.abort();await flight.done}}
  }

  private async fetchForward(root:MessageKey,record:StoredMessage,rootMessageId:MessageId,resourceId:ForwardId,signal:AbortSignal):Promise<OneBotForwardResult>{
    const generation=this.#generation,abort=AbortSignal.any([signal,this.#lifetime.signal])
    try{
      const result=await this.#socket.call('get_forward_msg',{id:resourceId},abort)
      if(abort.aborted)return{status:'failed',code:'cancelled'}
      if(generation!==this.#generation||this.#messages.get(root)!==record)return{status:'failed',code:'unavailable'}
      if(result.kind!=='ok')return{status:'failed',code:result.kind==='rejected'?'rejected':result.kind==='uncertain'&&result.code==='timeout'?'timeout':result.kind==='not-sent'&&result.code==='busy'?'capacity':'unavailable'}
      let parsed:ParsedForward
      try{parsed=parseForward(result.data,record.parsed.message.scope,this.#spec,()=>identifier('im.attachment',randomUUID()))}catch(error){return{status:'failed',code:error instanceof Error&&['forward-limit','segment-limit','text-limit'].includes(error.message)?'capacity':'malformed'}}
      const grants=new Set([...record.forwardGrants,...parsed.resources]),bytes=Buffer.byteLength(JSON.stringify(parsed))
      if(grants.size>this.#spec.maxForwardResources||record.forwardNodes+parsed.nodeCount>this.#spec.maxForwardNodes||this.#referenceBytes+bytes>this.#spec.maxReferenceBytes)return{status:'failed',code:'capacity'}
      record.forwards.set(resourceId,parsed);record.forwardNodes+=parsed.nodeCount;record.bytes+=bytes;record.expires=this.now()+this.#spec.referenceTtlMs;this.#referenceBytes+=bytes
      for(const id of grants)record.forwardGrants.add(id)
      for(const item of parsed.media)this.#sources.set(item.id,{key:root,source:item.source})
      return{status:'resolved',scope:record.parsed.message.scope,rootMessageId,resourceId,nodes:parsed.nodes,raw:parsed.raw}
    }catch(error){return{status:'failed',code:abort.aborted?'cancelled':'unavailable'}}
  }

  /**
   * Abort producer work, stop its socket, and join all publication/probe tasks.
   * @returns stable shutdown completion; callbacks cannot outlive it.
   */
  dispose(): Promise<void> {
    if (this.#closing) return this.#closing
    this.#closing = Promise.resolve().then(() => this.finishDispose())
    this.#lifetime.abort(); this.#health?.abort(); this.#phase = 'stopped'; this.#online = false; this.#generation++
    return this.#closing
  }

  /** Return only sanitized state during incidental JSON serialization. */
  toJSON(): OneBotStatus { return this.status() }
  /** Keep debugger output free of endpoints, request objects and credentials. */
  [inspect.custom](): OneBotStatus { return this.status() }

  private now(): number { return this.#hooks.now ? this.#hooks.now() : Date.now() }
  private emitStatus(): void {
    try { this.#hooks.status?.(this.status()) } catch (error) { this.#fault = 'status-listener-failed' }
  }

  private connectionChanged(connected: boolean): void {
    for(const flight of this.#forwardCalls.values())flight.controller.abort()
    this.#health?.abort(); this.#generation++; this.#revision++; this.#verified = false; this.#admitted = false; this.#online = false; this.#members.clear(); this.#memberTasks.clear()
    if (this.#lifetime.signal.aborted) return
    if (!connected) {
      this.#rejected += this.#early.length; this.#early.length = 0; this.#queuedBytes = 0
      if (this.#phase !== 'blocked') this.#phase = 'offline'
      this.emitStatus(); return
    }
    this.#phase = 'verifying'; this.emitStatus()
    const controller = new AbortController(), generation = this.#generation
    this.#health = controller
    const task = this.healthLoop(generation, AbortSignal.any([controller.signal, this.#lifetime.signal]))
    this.#healthTasks.add(task)
    void task.then(() => { this.#healthTasks.delete(task) }, () => { this.#healthTasks.delete(task); this.#fault = 'health-loop-failed'; this.#online = false; this.emitStatus() })
  }

  private async healthLoop(generation: number, signal: AbortSignal): Promise<void> {
    while (!signal.aborted && generation === this.#generation) {
      await this.probe(generation, signal)
      if (signal.aborted || generation !== this.#generation) return
      try { await delay(this.#spec.healthIntervalMs, undefined, { signal }) } catch (error) { if (!signal.aborted) throw error }
    }
  }

  private async probe(generation: number, lifetime: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(this.#spec.healthTimeoutMs)])
    const revision = this.#revision
    const login = await this.#socket.call('get_login_info', {}, signal)
    if (lifetime.aborted || generation !== this.#generation) return
    if (login.kind !== 'ok' || !isRecord(login.data)) { this.#online = false; this.#fault = 'login-probe-failed'; this.#phase = 'offline'; this.emitStatus(); return }
    if (wireId(login.data.user_id) !== this.#spec.accountId) {
      this.#verified = false; this.#online = false; this.#phase = 'blocked'; this.#fault = 'account-mismatch'
      this.#rejected += this.#early.length; this.#early.length = 0; this.#queuedBytes = 0
      this.#socket.suspend('account-mismatch'); this.emitStatus(); return
    }
    this.#verified = true
    const status = await this.#socket.call('get_status', {}, signal)
    if (lifetime.aborted || generation !== this.#generation) return
    if (revision === this.#revision) this.#online = status.kind === 'ok' && isRecord(status.data) && status.data.online === true && status.data.good === true
    this.#lastProbe = this.now(); this.#admitted = true
    this.#phase = this.#online ? 'online' : 'offline'
    if (this.#online) this.#fault = null
    const early = this.#early.splice(0); this.#queuedBytes = 0
    for (const entry of early) this.deliver(entry.parsed, entry.bytes)
    this.emitStatus()
  }

  private receive(value: unknown, bytes: number): void {
    if (this.#lifetime.signal.aborted || !isRecord(value)) return
    if (value.post_type === 'meta_event' && value.meta_event_type === 'heartbeat' && isRecord(value.status) && value.status.online === false) {
      this.#revision++; this.#online = false; this.#phase = 'offline'; this.emitStatus(); return
    }
    if (value.post_type === 'notice' && value.notice_type === 'group_ban') { this.muteNotice(value); return }
    let parsed: ParsedMessage | null
    try { parsed = parseMessage(value, this.#spec, this.now(), () => identifier('im.attachment', randomUUID())) } catch (error) {
      this.#rejected++; this.#fault = error instanceof Error && error.message === 'account-mismatch' ? 'account-mismatch' : 'invalid-message'
      if (this.#fault === 'account-mismatch') { this.#verified = false; this.#online = false; this.#phase = 'blocked'; this.#socket.suspend('account-mismatch') }
      this.emitStatus(); return
    }
    if (!parsed) return
    if (!this.#admitted) {
      if (this.#early.length >= this.#spec.maxPendingMessages || this.#queuedBytes + bytes > this.#spec.maxQueuedMessageBytes) {
        this.#rejected++; this.#fault = 'inbound-buffer-full'; this.#online = false; this.#phase = 'blocked'; this.#socket.suspend('inbound-buffer-full'); this.emitStatus(); return
      }
      this.#early.push({ parsed, bytes }); this.#queuedBytes += bytes; return
    }
    this.deliver(parsed, bytes)
  }

  private deliver(parsed: ParsedMessage, bytes: number): void {
    this.prune()
    const key = messageKey(parsed.message.scope, parsed.message.messageId)
    if (this.#messages.has(key)) { this.#duplicates++; this.emitStatus(); return }
    if (bytes > this.#spec.maxReferenceBytes || this.#deliveries.size >= this.#spec.maxPendingMessages) { this.#rejected++; this.#fault = 'inbound-capacity-exceeded'; this.emitStatus(); return }
    const evictions: MessageKey[] = []
    let count = this.#messages.size, retainedBytes = this.#referenceBytes
    for (const [candidate, record] of this.#messages) {
      if (count < this.#spec.maxReferences && retainedBytes + bytes <= this.#spec.maxReferenceBytes) break
      if (this.pinned(candidate)) continue
      evictions.push(candidate); count--; retainedBytes -= record.bytes
    }
    if (count >= this.#spec.maxReferences || retainedBytes + bytes > this.#spec.maxReferenceBytes) { this.#rejected++; this.#fault = 'inbound-capacity-exceeded'; this.emitStatus(); return }
    for (const candidate of evictions) this.dropMessage(candidate)
    this.#messages.set(key, { parsed, bytes, expires: this.now() + this.#spec.referenceTtlMs,forwardGrants:new Set(parsed.message.parts.flatMap(part=>part.type==='forward'?[part.resourceId]:[])),forwards:new Map(),forwardNodes:0 }); this.#referenceBytes += bytes
    for (const source of parsed.media) this.#sources.set(source.id, { key, source: source.source })
    this.#received++
    this.#activeMessages.add(key)
    const task = Promise.resolve().then(() => this.#lifetime.signal.aborted ? undefined : this.#hooks.message(parsed.message, this.#lifetime.signal))
    this.#deliveries.add(task)
    const finish = (): void => { this.#deliveries.delete(task); this.#activeMessages.delete(key); this.prune(); this.emitStatus() }
    void task.then(finish, () => { this.#fault = 'message-consumer-failed'; finish() })
    this.emitStatus()
  }

  private member(peerId: string): Promise<Member | null> {
    const cached = this.#members.get(peerId)
    if (cached && cached.expires > this.now()) return Promise.resolve(cached)
    const existing = this.#memberTasks.get(peerId)
    if (existing) return existing
    const generation = this.#generation, observedAt = this.now()
    const task = this.#socket.call('get_group_member_info', { group_id: Number(peerId), user_id: Number(this.#spec.accountId), no_cache: true }, this.#lifetime.signal).then(result => {
      if (generation !== this.#generation) return null
      if (result.kind !== 'ok' || !isRecord(result.data) || wireId(result.data.user_id) !== this.#spec.accountId) { this.#fault = 'member-probe-failed'; return null }
      const role = result.data.role === 'owner' || result.data.role === 'admin' ? result.data.role : 'member'
      const rawUntil = result.data.shut_up_timestamp
      const until = typeof rawUntil === 'number' && Number.isFinite(rawUntil) && rawUntil >= 0 ? rawUntil * 1000 : 0
      const member: Member = { role, until, observedAt, expires: this.now() + this.#spec.membershipCacheMs }
      this.#members.set(peerId, member); return member
    })
    this.#memberTasks.set(peerId, task)
    void task.then(() => { if (this.#memberTasks.get(peerId) === task) this.#memberTasks.delete(peerId) }, () => { if (this.#memberTasks.get(peerId) === task) this.#memberTasks.delete(peerId) })
    return task
  }

  private muteNotice(value: JsonRecord): void {
    const group = wireId(value.group_id), target = wireId(value.user_id)
    if (wireId(value.self_id) !== this.#spec.accountId || !group || !this.#spec.allowedGroups.includes(group) || (target !== '0' && target !== this.#spec.accountId)) return
    if (value.sub_type !== 'ban' && value.sub_type !== 'lift_ban') return
    const state = this.#mutes.get(group) ?? {}, at = this.now()
    if (target === '0') state.whole = { active: value.sub_type === 'ban', at }
    else {
      const duration = typeof value.duration === 'number' && Number.isFinite(value.duration) && value.duration > 0 ? value.duration : 0
      state.individual = { until: value.sub_type === 'ban' ? at + duration * 1000 : 0, at }
    }
    this.#mutes.set(group, state); this.#members.delete(group); this.#notices++; this.emitStatus()
  }

  private encode(scope: ConversationScope, parts: readonly MessagePart[]): readonly WireSegment[] | null {
    this.prune()
    if (parts.length === 0 || parts.length > this.#spec.maxSegments) return null
    const result: WireSegment[] = []
    let bytes = 0
    for (const part of parts) {
      let segment: WireSegment
      switch (part.type) {
        case 'text': segment = { type: 'text', data: { text: part.text } }; break
        case 'mention':
          if (wireId(part.userId) === null) return null
          segment = { type: 'at', data: { qq: part.userId } }; break
        case 'reply':
          if (wireId(part.messageId) === null) return null
          segment = { type: 'reply', data: { id: part.messageId } }; break
        case 'card': segment = { type: part.format, data: { data: part.content } }; break
        case 'image':
        case 'audio':
        case 'video': {
          const media = this.#media.get(part.attachmentId)
          if (!media || media.kind !== part.type || !sameScope(media.scope, scope)) return null
          if (bytes + Math.ceil(media.bytes.byteLength * 4 / 3) > this.#spec.maxFrameBytes) return null
          segment = { type: part.type === 'audio' ? 'record' : part.type, data: { file: 'base64://' + media.bytes.toString('base64') } }; break
        }
        case 'file':
        case 'forward':
        case 'unsupported': return null
        default: return this.unreachable(part)
      }
      bytes += Buffer.byteLength(JSON.stringify(segment))
      if (bytes > this.#spec.maxFrameBytes) return null
      result.push(segment)
    }
    return result
  }

  private unreachable(value: never): never { throw new Error('Unrecognized message part') }

  private dropMessage(key: MessageKey): void {
    const record = this.#messages.get(key)
    if (!record) return
    this.#referenceBytes -= record.bytes; this.#messages.delete(key)
    for (const source of record.parsed.media) this.#sources.delete(source.id)
    for(const forward of record.forwards.values())for(const source of forward.media)this.#sources.delete(source.id)
  }

  private pinned(key:MessageKey):boolean{return this.#activeMessages.has(key)||this.#forwardPins.has(key)}

  private prune(): void {
    const now = this.now()
    for (const [key, record] of this.#messages) if (record.expires <= now && !this.pinned(key)) this.dropMessage(key)
    for (const [id, media] of this.#media) if (media.expires <= now) { this.#media.delete(id); this.#mediaBytes -= media.bytes.byteLength }
  }

  private async finishDispose(): Promise<void> {
    const results = await Promise.allSettled([this.#socket.close(), ...this.#healthTasks, ...this.#deliveries, ...this.#memberTasks.values(),...this.#forwardTasks])
    this.#messages.clear(); this.#sources.clear(); this.#media.clear(); this.#members.clear(); this.#mutes.clear(); this.#activeMessages.clear(); this.#early.length = 0; this.#queuedBytes = 0; this.#referenceBytes = 0; this.#mediaBytes = 0
    this.#forwardCalls.clear();this.#forwardPins.clear();this.#forwardTasks.clear()
    const failures: unknown[] = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'OneBot transport shutdown failed')
  }
}
