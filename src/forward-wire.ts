/** Bounded normalization of standard node envelopes and NapCat message envelopes. */
import {isDeepStrictEqual} from 'node:util'
import {identifier,type AttachmentId,type ConversationScope,type ForwardId} from 'dsh-im-kit'
import type {Spec} from './config.ts'
import {isRecord,parseContent,parseSegments,wireId,type JsonRecord,type ParsedMessage} from './wire.ts'
import type {OneBotForwardNode,OneBotForwardPart} from './forward-types.ts'

/** Parsed private cache entry; locations stay bound to the original outer scope. */
export interface ParsedForward{readonly raw:JsonRecord;readonly nodes:readonly OneBotForwardNode[];readonly media:ParsedMessage['media'];readonly resources:readonly ForwardId[];readonly nodeCount:number}
function id(value:unknown):string{const result=wireId(value);if(result===null)throw Error('invalid-forward-identity');return result}
function content(value:JsonRecord):unknown{
 const candidates=[value.content,value.message].filter(item=>item!==undefined),populated=candidates.filter(item=>!(item===''||Array.isArray(item)&&item.length===0))
 if(populated.length>1&&!isDeepStrictEqual(populated[0],populated[1]))throw Error('ambiguous-forward-content')
 if(!candidates.length)throw Error('missing-forward-content')
 return populated[0]??candidates[0]
}
/** @param value - decoded successful get_forward_msg data. @param scope - admitted outer scope, never a returned group ID. @param spec - validated limits. @param allocate - opaque attachment allocator. @returns ordered normalized nodes and host-only sources; excessive or ambiguous data is rejected intact. */
export function parseForward(value:unknown,scope:ConversationScope,spec:Spec,allocate:()=>AttachmentId):ParsedForward{
 if(!isRecord(value))throw Error('invalid-forward-response')
 if(value.messages!==undefined&&value.message!==undefined&&!isDeepStrictEqual(value.messages,value.message))throw Error('ambiguous-forward-response')
 const list=value.messages??value.message;if(!Array.isArray(list))throw Error('invalid-forward-nodes')
 const media:{id:AttachmentId;source:ParsedMessage['media'][number]['source']}[]=[],resources=new Set<ForwardId>();let count=0
 const node=(raw:unknown,depth:number):OneBotForwardNode=>{
  if(depth>spec.maxForwardDepth||++count>spec.maxForwardNodes)throw Error('forward-limit')
  if(!isRecord(raw))throw Error('invalid-forward-node')
  if(raw.type!==undefined&&raw.type!=='node')throw Error('invalid-forward-node-type')
  const data=raw.type==='node'?raw.data:raw;if(!isRecord(data))throw Error('invalid-forward-node')
  const sender=isRecord(data.sender)?data.sender:undefined,claimedId=data.user_id??sender?.user_id,name=data.nickname??sender?.nickname
  if(claimedId!==undefined&&!/^[1-9]/.test(id(claimedId)))throw Error('invalid-forward-sender')
  if(name!==undefined&&(typeof name!=='string'||name.length>spec.maxTextChars))throw Error('invalid-forward-name')
  const claimedSender={...claimedId===undefined?{}:{id:identifier('im.user',id(claimedId))},...typeof name==='string'?{name}:{}}
  if(data.id!==undefined){if(data.content!==undefined||data.message!==undefined)throw Error('ambiguous-forward-reference');return{claimedSender,referenceMessageId:identifier('im.message',id(data.id)),parts:[]}}
  const original=content(data),parsed=parseContent(original,scope,spec,allocate),segments=parseSegments(original,spec.maxSegments);media.push(...parsed.media)
  const parts:OneBotForwardPart[]=parsed.parts.map((part,index)=>{
   const segment=segments[index]!;if(segment.type==='node')return{type:'inline-forward',node:node({type:'node',data:segment.data},depth+1)}
   if(part.type==='forward')resources.add(part.resourceId);return part
  })
  const time=data.time;if(time!==undefined&&(typeof time!=='number'||!Number.isFinite(time)||time<0||time>Number.MAX_SAFE_INTEGER/1000))throw Error('invalid-forward-time')
  return{claimedSender,parts,...typeof time==='number'?{sentAt:time*1000}:{},...data.message_id===undefined?{}:{sourceMessageId:identifier('im.message',id(data.message_id))}}
 }
 const nodes=list.map(value=>node(value,1));return{raw:value,nodes,media,resources:[...resources],nodeCount:count}
}
