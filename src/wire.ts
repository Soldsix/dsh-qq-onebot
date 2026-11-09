/** OneBot wire normalization; source bytes and URLs remain behind opaque references. */
import { identifier, type InboundMessage, type MessagePart, type AccountRef, type AttachmentId, type ConversationScope } from 'dsh-im-kit'
import type { Spec } from './config.ts'

/** JSON object admitted at the protocol parser. */
export type JsonRecord = Record<string, unknown>
/** A OneBot segment before format-specific interpretation. */
export interface WireSegment { readonly type: string; readonly data: JsonRecord }
/** Host-only source location for an incoming attachment. */
export interface MediaSource {
  readonly scope: ConversationScope
  readonly kind: 'image' | 'audio' | 'video' | 'file'
  readonly url?: string
  readonly file?: string
  readonly name?: string
}
/** Normalized event and the host-only source references it introduces. */
export interface ParsedMessage {
  readonly message: InboundMessage
  readonly media: readonly { readonly id: AttachmentId; readonly source: MediaSource }[]
  readonly raw: JsonRecord
}

/**
 * Narrow protocol objects without accepting arrays or null.
 * @param value - decoded untrusted JSON.
 * @returns whether the value is a JSON object.
 */
export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Preserve integer message IDs, including the protocol's signed message IDs.
 * @param value - raw number or decimal string.
 * @returns an exact decimal string, or null when precision or format is invalid.
 */
export function wireId(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : null
  return typeof value === 'string' && /^-?(0|[1-9][0-9]*)$/.test(value) ? value : null
}

/**
 * Decode CQ escaping once, with ampersand last to preserve literal entity text.
 * @param value - raw text or parameter.
 * @param parameter - whether comma entities have parameter semantics.
 * @returns decoded text.
 */
export function unescapeCq(value: string, parameter: boolean): string {
  return value.replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(parameter ? /&#44;/g : /$^/g, ',').replace(/&amp;/g, '&')
}

/**
 * Parse arrays or CQ strings while retaining unsupported segment types.
 * @param value - untrusted message field.
 * @param maxSegments - configured maximum; excess content is rejected, not truncated.
 * @returns validated segments.
 * @throws Error for malformed or excessive input.
 */
export function parseSegments(value: unknown, maxSegments: number): readonly WireSegment[] {
  if (Array.isArray(value)) {
    if (value.length > maxSegments) throw new Error('segment-limit')
    return value.map(segment => {
      if (!isRecord(segment) || typeof segment.type !== 'string' || !isRecord(segment.data)) throw new Error('invalid-segment')
      return { type: segment.type, data: segment.data }
    })
  }
  if (typeof value !== 'string') throw new Error('invalid-message')
  const segments: WireSegment[] = []
  const add = (segment: WireSegment): void => {
    if (segments.length >= maxSegments) throw new Error('segment-limit')
    segments.push(segment)
  }
  const pattern = /\[CQ:([A-Za-z0-9_-]+)(?:,([^\]]*))?\]/g
  let offset = 0
  for (const match of value.matchAll(pattern)) {
    if (match.index > offset) add({ type: 'text', data: { text: unescapeCq(value.slice(offset, match.index), false) } })
    const data: JsonRecord = Object.create(null)
    for (const item of (match[2] ?? '').split(',').filter(Boolean)) {
      const separator = item.indexOf('=')
      if (separator < 1) throw new Error('invalid-cq-parameter')
      const key = item.slice(0, separator)
      if (Object.hasOwn(data, key)) throw new Error('duplicate-cq-parameter')
      data[key] = unescapeCq(item.slice(separator + 1), true)
    }
    add({ type: match[1]!, data })
    offset = match.index + match[0].length
  }
  if (offset < value.length || segments.length === 0) add({ type: 'text', data: { text: unescapeCq(value.slice(offset), false) } })
  return segments
}

/**
 * Apply operator allowlists to an exact host-bound destination.
 * @param scope - destination whose account must match the provider.
 * @param spec - operator policy.
 * @returns whether this transport admits the destination.
 */
export function allowsScope(scope: ConversationScope, spec: Spec): boolean {
  const a = scope.account, b = spec.account
  if (a.accountId !== b.accountId || a.tenantId !== b.tenantId || a.networkId !== b.networkId) return false
  return scope.kind === 'group'
    ? spec.allowedGroups.includes(scope.peerId)
    : spec.allowPrivate && (spec.privateUsers.length === 0 || spec.privateUsers.includes(scope.peerId))
}

/**
 * Admit messages only from the bound account and configured conversations.
 * @param value - decoded OneBot frame.
 * @param spec - trusted transport identity and limits.
 * @param receivedAt - host receipt time.
 * @param allocate - host allocator for opaque attachment identities.
 * @returns a normalized event or null for non-message, self, or unadmitted events.
 * @throws Error for malformed admitted content.
 */
export function parseMessage(value: unknown, spec: Spec, receivedAt: number, allocate: () => AttachmentId): ParsedMessage | null {
  if (!isRecord(value) || value.post_type !== 'message') return null
  if (wireId(value.self_id) !== spec.accountId) throw new Error('account-mismatch')
  if (value.message_type !== 'group' && value.message_type !== 'private') return null
  const sender = wireId(value.user_id)
  if (!sender || !/^[1-9]/.test(sender)) throw new Error('invalid-sender')
  if (sender === spec.accountId) return null
  const peer = value.message_type === 'group' ? wireId(value.group_id) : sender
  const id = wireId(value.message_id)
  if (!peer || !/^[1-9]/.test(peer) || id === null) throw new Error('invalid-message-identity')
  const scope: ConversationScope = { account: spec.account, kind: value.message_type, peerId: identifier('im.peer', peer) }
  if (!allowsScope(scope, spec)) return null
  if (typeof value.time !== 'number' || !Number.isFinite(value.time) || value.time < 0 || value.time > Number.MAX_SAFE_INTEGER / 1000) throw new Error('invalid-message-time')
  const {parts,media,directed}=parseContent(value.message,scope,spec,allocate)
  return {
    raw: value, media,
    message: { scope, messageId: identifier('im.message', id), senderId: identifier('im.user', sender), sentAt: value.time * 1000, receivedAt, parts, directedToBot: directed },
  }
}

/** Normalized segments and host-only locations; mention flags do not authenticate forwarded speakers. */
export interface ParsedContent{readonly parts:readonly MessagePart[];readonly media:ParsedMessage['media'];readonly directed:boolean}
/** @param value - wire message array or CQ text. @param scope - host-bound outer destination. @param spec - transport limits and expected account. @param allocate - host attachment allocator. @returns normalized content without changing the originating sender or destination. */
export function parseContent(value:unknown,scope:ConversationScope,spec:Spec,allocate:()=>AttachmentId):ParsedContent{
  const parts: MessagePart[] = [], media: { id: AttachmentId; source: MediaSource }[] = []
  let textChars = 0
  let directed = scope.kind === 'private'
  for (const segment of parseSegments(value, spec.maxSegments)) {
    const d = segment.data
    switch (segment.type) {
      case 'text': {
        if (typeof d.text !== 'string') throw new Error('invalid-text')
        textChars += d.text.length
        if (textChars > spec.maxTextChars) throw new Error('text-limit')
        parts.push({ type: 'text', text: d.text })
        break
      }
      case 'at': {
        const target = wireId(d.qq)
        if (d.qq === 'all') parts.push({ type: 'unsupported', segmentType: 'at-all' })
        else if (target !== null) {
          parts.push({ type: 'mention', userId: identifier('im.user', target) })
          if (target === spec.accountId) directed = true
        } else throw new Error('invalid-mention')
        break
      }
      case 'reply': {
        const target = wireId(d.id)
        if (target === null) throw new Error('invalid-reply')
        parts.push({ type: 'reply', messageId: identifier('im.message', target) })
        break
      }
      case 'image':
      case 'mface':
      case 'record':
      case 'video':
      case 'file': {
        const kind = segment.type === 'record' ? 'audio' : segment.type === 'mface' ? 'image' : segment.type
        const id = allocate()
        const source: MediaSource = {
          scope, kind,
          ...(typeof d.url === 'string' ? { url: d.url } : {}),
          ...(typeof d.file === 'string' ? { file: d.file } : {}),
          ...(typeof d.name === 'string' ? { name: d.name } : {}),
        }
        media.push({ id, source })
        parts.push(kind === 'file' ? { type: 'file', attachmentId: id, name: source.name ?? 'attachment' } : { type: kind, attachmentId: id })
        break
      }
      case 'forward':
        if (typeof d.id !== 'string' || d.id.length === 0) throw new Error('invalid-forward')
        parts.push({ type: 'forward', resourceId: identifier('im.forward', d.id) })
        break
      case 'json':
      case 'xml':
        if (typeof d.data !== 'string') throw new Error('invalid-card')
        textChars += d.data.length
        if (textChars > spec.maxTextChars) throw new Error('text-limit')
        parts.push({ type: 'card', format: segment.type, content: d.data })
        break
      default:
        parts.push({ type: 'unsupported', segmentType: segment.type })
    }
  }
  return{parts,media,directed}
}
