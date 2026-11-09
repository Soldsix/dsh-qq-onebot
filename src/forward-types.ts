/** Forwarded identities are unverified claims within one admitted outer conversation. */
import type {ConversationScope,ForwardId,MessageId,UserId,MessagePart,DeliveryReceipt} from 'dsh-im-kit'
import type {JsonRecord} from './wire.ts'

/** Inline nodes preserve their exact position among ordinary message parts. */
export type OneBotForwardPart=MessagePart|{readonly type:'inline-forward';readonly node:OneBotForwardNode}
/** A forwarded node never becomes an authenticated inbound message or command. */
export interface OneBotForwardNode{
 readonly claimedSender:{readonly id?:UserId;readonly name?:string}
 readonly sentAt?:number
 readonly sourceMessageId?:MessageId
 readonly referenceMessageId?:MessageId
 readonly parts:readonly OneBotForwardPart[]
}
/** Read failures never imply that an incomplete forward is complete. */
export type ForwardReadFailure='permission-denied'|'not-found'|'offline'|'cancelled'|'capacity'|'malformed'|'rejected'|'timeout'|'unavailable'
/** Scoped normalized content plus an independent exact response snapshot for trusted Host readers. */
export type OneBotForwardResult=
 |{readonly status:'resolved';readonly scope:ConversationScope;readonly rootMessageId:MessageId;readonly resourceId:ForwardId;readonly nodes:readonly OneBotForwardNode[];readonly raw:JsonRecord}
 |{readonly status:'failed';readonly code:ForwardReadFailure}

/** Installed Host resolver owns durable prepared content; models cannot register dispatchers. */
export interface OneBotForwardDispatcher{
 /** @param scope - authenticated outbound destination. @param resource - opaque retained output identity. @param signal - caller and registration lifetime. @returns classified receipt without automatic retries. */
 send(scope:ConversationScope,resource:ForwardId,signal:AbortSignal):Promise<DeliveryReceipt>
}
