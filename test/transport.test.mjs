import test from 'node:test'
import assert from 'node:assert/strict'
import {once} from 'node:events'
import {inspect} from 'node:util'
import {identifier} from 'dsh-im-kit'
import {fixture,reply} from './transport-fixture.mjs'
import {deferred,message} from './helpers.mjs'

const signal=()=>new AbortController().signal
const options={timeout:30000}

test('a connected WebSocket is not treated as QQ online',options,async t=>{
 const f=await fixture(t,{intercept(peer,request){if(request.action==='get_status'){reply(peer,request,{online:false,good:true});return true}}})
 await f.state(state=>state.verified&&state.phase==='offline')
 assert.equal(await f.transport.availability(f.scope(),signal()),'offline')
 assert.deepEqual(await f.transport.send(f.outbound(),signal()),{status:'failed',code:'offline'})
 assert.equal(f.requests.some(r=>r.action.startsWith('send_')),false)
})

test('messages received before identity verification publish once after admission',options,async t=>{
 const f=await fixture(t,{intercept(peer,request){if(request.action==='get_login_info'){
  peer.send(JSON.stringify(message({message_id:41})));peer.send(JSON.stringify(message({message_id:41})))
  reply(peer,request,{user_id:90000001});return true
 }}})
 await f.ready();await f.message(m=>m.messageId==='41')
 assert.equal(f.transport.status().received,1)
 assert.equal(f.transport.status().duplicates,1)
 assert.equal(f.messages.length,1)
})

test('a verified wrong account blocks admission instead of replaying buffered messages',options,async t=>{
 const f=await fixture(t,{intercept(peer,request){if(request.action==='get_login_info'){
  peer.send(JSON.stringify(message()));reply(peer,request,{user_id:90000009});return true
 }}})
 await f.state(state=>state.fault==='account-mismatch')
 assert.equal(f.transport.status().online,false)
 assert.equal(f.transport.status().verified,false)
 assert.equal(f.messages.length,0)
 assert.equal(await f.transport.availability(f.scope(),signal()),'offline')
})

test('unverified messages from a disconnected generation cannot enter a later session',options,async t=>{
 const f=await fixture(t,{intercept(peer,request,connection){if(connection===1&&request.action==='get_login_info'){
  peer.send(JSON.stringify(message({message_id:43})))
  peer.send(JSON.stringify({post_type:'meta_event',meta_event_type:'heartbeat',status:{online:false}}));return true
 }}})
 await f.state(state=>state.phase==='offline')
 f.peer.terminate()
 await f.ready()
 assert.equal(f.transport.status().received,0)
 assert.equal(f.messages.length,0)
})

test('original messages and media references stay isolated by conversation',options,async t=>{
 let now=1000
 const f=await fixture(t,{config:{allowedGroups:['90000100','90000101'],referenceTtlMs:100},now:()=>now})
 await f.ready()
 const wire=message({message_id:44,message:[{type:'reply',data:{id:'-8'}},{type:'image',data:{file:'original.gif',url:'https://example.test/original.gif'}}]})
 f.peer.send(JSON.stringify(wire));const parsed=await f.message(m=>m.messageId==='44')
 const id=parsed.parts[1].attachmentId
 assert.equal(f.transport.mediaSource(f.scope(),id).url,'https://example.test/original.gif')
 assert.equal(f.transport.mediaSource(f.scope('90000101'),id),undefined)
 assert.deepEqual(f.transport.original(f.scope(),identifier('im.message','44')),wire)
 const copy=f.transport.original(f.scope(),identifier('im.message','44'));copy.message=[]
 assert.equal(f.transport.original(f.scope(),identifier('im.message','44')).message.length,2)
 await f.state(state=>state.activeDeliveries===0)
 now+=101
 assert.equal(f.transport.original(f.scope(),identifier('im.message','44')),undefined)
 assert.equal(f.transport.mediaSource(f.scope(),id),undefined)
})

test('media required by an active consumer cannot be evicted by a later message',options,async t=>{
 const entered=deferred()
 const f=await fixture(t,{config:{maxReferences:1},onMessage:async(_message,cancellation)=>{
  entered.resolve();await new Promise(resolve=>cancellation.addEventListener('abort',resolve,{once:true}))
 }})
 await f.ready()
 f.peer.send(JSON.stringify(message({message_id:45,message:[{type:'image',data:{url:'https://example.test/pinned.png'}}]})))
 await entered.promise
 const first=f.messages[0],id=first.parts[0].attachmentId
 f.peer.send(JSON.stringify(message({message_id:46})))
 await f.state(state=>state.received===2||state.rejected===1)
 assert.equal(f.transport.mediaSource(f.scope(),id)?.url,'https://example.test/pinned.png')
 assert.equal(f.transport.status().rejected,1)
})

test('membership requests coalesce while cancelling only one waiter',options,async t=>{
 const member=deferred()
 const f=await fixture(t,{intercept(peer,request){if(request.action==='get_group_member_info'){member.resolve({peer,request});return true}}})
 await f.ready()
 const control=new AbortController()
 const first=f.transport.availability(f.scope(),control.signal),second=f.transport.availability(f.scope(),signal())
 const pending=await member.promise;control.abort()
 assert.equal(await first,'disabled')
 reply(pending.peer,pending.request,{user_id:90000001,role:'member',shut_up_timestamp:0})
 assert.equal(await second,'available')
 assert.equal(f.requests.filter(r=>r.action==='get_group_member_info').length,1)
})

test('mute notices take precedence over an older membership probe',options,async t=>{
 let now=1000
 const member=deferred()
 const f=await fixture(t,{now:()=>now,intercept(peer,request){if(request.action==='get_group_member_info'){member.resolve({peer,request});return true}}})
 await f.ready();const availability=f.transport.availability(f.scope(),signal())
 const pending=await member.promise;now++
 f.peer.send(JSON.stringify({post_type:'notice',notice_type:'group_ban',self_id:90000001,group_id:90000100,user_id:90000001,sub_type:'ban',duration:60}))
 await f.state(state=>state.notices===1)
 reply(pending.peer,pending.request,{user_id:90000001,role:'member',shut_up_timestamp:0})
 assert.equal(await availability,'muted')
 assert.deepEqual(await f.transport.send(f.outbound(),signal()),{status:'failed',code:'muted'})
 assert.equal(f.requests.filter(r=>r.action==='send_group_msg').length,0)
})

test('whole-group mute blocks members while exempting an administrator',options,async t=>{
 let role='member'
 const f=await fixture(t,{intercept(peer,request){if(request.action==='get_group_member_info'){reply(peer,request,{user_id:90000001,role,shut_up_timestamp:0});return true}}})
 await f.ready()
 const notice=()=>({post_type:'notice',notice_type:'group_ban',self_id:90000001,group_id:90000100,user_id:0,sub_type:'ban',duration:0})
 f.peer.send(JSON.stringify(notice()));await f.state(s=>s.notices===1)
 assert.equal(await f.transport.availability(f.scope(),signal()),'muted')
 role='admin';f.peer.send(JSON.stringify(notice()));await f.state(s=>s.notices===2)
 assert.equal(await f.transport.availability(f.scope(),signal()),'available')
})

test('heartbeat offline evidence cannot be overwritten by an older positive health response',options,async t=>{
 const response=deferred()
 const f=await fixture(t,{intercept(peer,request){if(request.action==='get_status'){response.resolve({peer,request});return true}}})
 const pending=await response.promise
 f.peer.send(JSON.stringify({post_type:'meta_event',meta_event_type:'heartbeat',status:{online:false}}))
 await f.state(s=>s.phase==='offline')
 reply(pending.peer,pending.request,{online:true,good:true})
 await f.state(s=>s.verified&&s.phase==='offline')
 assert.equal(f.transport.status().online,false)
})

test('online evidence expires even if the TCP connection remains open',options,async t=>{
 let now=1000
 const f=await fixture(t,{now:()=>now,config:{onlineStaleMs:100}})
 await f.ready();now+=101
 assert.equal(f.transport.status().connected,true)
 assert.equal(f.transport.status().online,false)
 assert.equal(f.transport.status().phase,'offline')
 assert.equal(await f.transport.availability(f.scope(),signal()),'offline')
})

test('outbound media copies original bytes and refuses cross-scope references',options,async t=>{
 const f=await fixture(t,{config:{allowedGroups:['90000100','90000101'],maxMediaBytes:8,maxStoredMediaBytes:8}})
 await f.ready()
 const bytes=Buffer.from([137,80,78,71,13,10,26,10]),id=f.transport.registerMedia(f.scope(),'image',bytes,'fixture.png')
 bytes.fill(0)
 assert.deepEqual(await f.transport.send(f.outbound([{type:'image',attachmentId:id}],f.scope('90000101')),signal()),{status:'failed',code:'rejected'})
 assert.equal(f.requests.some(r=>r.action==='send_group_msg'),false)
 const receipt=await f.transport.send(f.outbound([{type:'image',attachmentId:id}]),signal())
 assert.equal(receipt.status,'accepted')
 const call=f.requests.find(r=>r.action==='send_group_msg')
 assert.equal(call.params.message[0].data.file,'base64://iVBORw0KGgo=')
 assert.throws(()=>f.transport.registerMedia(f.scope(),'image',Buffer.of(1)),/capacity/)
 assert.equal(f.transport.releaseMedia(f.scope('90000101'),id),false)
 assert.equal(f.transport.releaseMedia(f.scope(),id),true)
 assert.equal(f.transport.status().storedMediaBytes,0)
})

test('different groups and private messages dispatch concurrently without a global send lock',options,async t=>{
 const pending=[]
 const f=await fixture(t,{config:{allowedGroups:['90000100','90000101']},intercept(peer,request){if(request.action.startsWith('send_')){pending.push({peer,request});return true}}})
 await f.ready()
 const targets=[f.scope(),f.scope('90000101'),f.scope('90000002','private')]
 const sends=targets.map(scope=>f.transport.send(f.outbound([{type:'text',text:'parallel'}],scope),signal()))
 await f.request(request=>request.action==='send_group_msg'&&request.params.group_id===90000101)
 await f.request(request=>request.action==='send_private_msg')
 assert.equal(pending.length,3)
 for(const [index,entry]of pending.entries())reply(entry.peer,entry.request,{message_id:100+index})
 assert.deepEqual((await Promise.all(sends)).map(r=>r.status),['accepted','accepted','accepted'])
})

test('server rejection is definitive while success without a message ID stays uncertain',options,async t=>{
 let attempt=0
 const f=await fixture(t,{intercept(peer,request){if(request.action==='send_group_msg'){
  if(attempt++===0)peer.send(JSON.stringify({status:'failed',retcode:1403,data:null,echo:request.echo}));else reply(peer,request,{})
  return true
 }}})
 await f.ready()
 assert.deepEqual(await f.transport.send(f.outbound(),signal()),{status:'failed',code:'permission-denied'})
 assert.deepEqual(await f.transport.send(f.outbound(),signal()),{status:'uncertain',code:'provider-error'})
 assert.equal(attempt,2)
})

test('dispose cancels and awaits active publications and prevents later callbacks',options,async t=>{
 const entered=deferred(),settled=deferred()
 const f=await fixture(t,{onMessage:async(_message,cancellation)=>{
  entered.resolve();await new Promise(resolve=>cancellation.addEventListener('abort',resolve,{once:true}));settled.resolve()
 }})
 await f.ready();f.peer.send(JSON.stringify(message()));await entered.promise
 const closing=f.transport.dispose();assert.equal(closing,f.transport.dispose())
 await closing;await settled.promise
 assert.equal(f.transport.status().activeDeliveries,0)
 assert.equal(f.transport.status().phase,'stopped')
 assert.ok(!JSON.stringify(f.transport).includes('fixture-only-token'))
 assert.ok(!inspect(f.transport).includes('127.0.0.1'))
})
