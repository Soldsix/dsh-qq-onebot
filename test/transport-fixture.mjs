/** Isolated loopback protocol peer; it never connects to QQ. */
import {once,EventEmitter} from 'node:events'
import {WebSocketServer} from 'ws'
import {identifier} from 'dsh-im-kit'
import {OneBotTransport} from '../dist/transport.js'
import {spec,deferred} from './helpers.mjs'

export function reply(peer,request,data){peer.send(JSON.stringify({status:'ok',retcode:0,data,echo:request.echo}))}

export async function fixture(t,{config={},intercept,onMessage,now}={}){
 const cleanups=[],bus=new EventEmitter(),server=new WebSocketServer({host:'127.0.0.1',port:0})
 t.after(async()=>{const failures=[];for(const dispose of cleanups.reverse())try{await dispose()}catch(error){failures.push(error)}if(failures.length)throw new AggregateError(failures)})
 cleanups.push(()=>new Promise(resolve=>{for(const peer of server.clients)peer.terminate();server.close(resolve)}))
 await once(server,'listening')
 const requests=[],messages=[],peers=[],opened=deferred(),status=[]
 let connections=0
 server.on('connection',peer=>{
  connections++;peers.push(peer);opened.resolve(peer)
  peer.on('message',raw=>{
   const request=JSON.parse(raw.toString());requests.push(request);bus.emit('request',request)
   if(intercept?.(peer,request,connections))return
   if(request.action==='get_login_info')reply(peer,request,{user_id:90000001})
   else if(request.action==='get_status')reply(peer,request,{online:true,good:true})
   else if(request.action==='get_group_member_info')reply(peer,request,{user_id:90000001,role:'member',shut_up_timestamp:0})
   else reply(peer,request,{message_id:1000+requests.length})
  })
 })
 const transport=new OneBotTransport(spec({forwardUrl:'ws://127.0.0.1:'+server.address().port,actionTimeoutMs:2000,healthTimeoutMs:2000,healthIntervalMs:60000,...config}),{
  async message(value,signal){messages.push(value);bus.emit('message',value);await onMessage?.(value,signal)},
  status(value){status.push(value);bus.emit('status',value)},...(now?{now}:{}),
 })
 cleanups.push(()=>transport.dispose())
 function wait(event,predicate,current){
  const existing=current?.find(predicate);if(existing)return Promise.resolve(existing)
  if(t.signal.aborted)return Promise.reject(t.signal.reason)
  return new Promise((resolve,reject)=>{
   const done=()=>{bus.off(event,listener);t.signal.removeEventListener('abort',abort)}
   const listener=value=>{if(predicate(value)){done();resolve(value)}}
   const abort=()=>{done();reject(t.signal.reason)}
   bus.on(event,listener);t.signal.addEventListener('abort',abort,{once:true})
  })
 }
 await transport.start()
 const peer=await opened.promise
 const account=transport.account
 const scope=(id='90000100',kind='group')=>({account,kind,peerId:identifier('im.peer',id)})
 const outbound=(parts=[{type:'text',text:'fixture reply'}],target=scope())=>({scope:target,operationId:identifier('im.operation','fixture-'+(requests.length+1)),parts})
 return {transport,server,peer,peers,requests,messages,status,scope,outbound,
  ready:()=>wait('status',value=>value.online,status),
  state:predicate=>predicate(transport.status())?Promise.resolve(transport.status()):wait('status',predicate),
  request:predicate=>wait('request',predicate,requests),
  message:predicate=>wait('message',predicate,messages),
 }
}
