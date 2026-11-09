/** Loopback merged-forward writes preserve exact bytes and classify uncertain dispatch once. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {identifier} from 'dsh-im-kit'
import {fixture,reply} from './transport-fixture.mjs'
import {message,deferred} from './helpers.mjs'
const signal=()=>new AbortController().signal
const node=(parts=[{type:'text',text:'original'}])=>({claimedSender:{id:identifier('im.user','90000002'),name:'fixture'},sentAt:1000,parts})
const sent=f=>f.requests.filter(request=>request.action==='send_group_forward_msg'||request.action==='send_private_forward_msg')
const options={timeout:30000}

test('merged group and private writes preserve node order, nested claims and registered original bytes',options,async t=>{
 const f=await fixture(t);await f.ready()
 for(const scope of[f.scope(),f.scope('90000002','private')]){
  const bytes=Buffer.from('synthetic complete binary\u0000\u00ff'),id=f.transport.registerMedia(scope,'image',bytes)
  const nodes=[node([{type:'text',text:'before'},{type:'inline-forward',node:node([{type:'image',attachmentId:id},{type:'text',text:'after'}])}]),node([{type:'card',format:'json',content:'{"untrusted":true}'}])]
  assert.equal((await f.transport.sendForwardNodes(scope,nodes,signal())).status,'accepted')
  const wire=sent(f).at(-1);assert.equal(wire.action,scope.kind==='group'?'send_group_forward_msg':'send_private_forward_msg');assert.equal(wire.params[scope.kind==='group'?'group_id':'user_id'],Number(scope.peerId));assert.equal(wire.params.messages[0].data.user_id,'90000002');assert.equal(wire.params.messages[0].data.content[0].data.text,'before')
  const nested=wire.params.messages[0].data.content[1];assert.equal(nested.type,'node');assert.deepEqual(Buffer.from(nested.data.content[0].data.file.slice('base64://'.length),'base64'),bytes);assert.equal(nested.data.content[1].data.text,'after');assert.equal(wire.params.messages[1].data.content[0].type,'json');assert.equal(f.transport.releaseMedia(scope,id),true)
 }
 assert.equal(sent(f).length,2)
})

test('expired or foreign reference IDs and mixed unsupported content never produce a partial forward',options,async t=>{
 let now=1000;const f=await fixture(t,{now:()=>now,config:{allowedGroups:['90000100','90000101'],referenceTtlMs:100,onlineStaleMs:10000}});await f.ready()
 f.peer.send(JSON.stringify(message({message_id:71})));await f.message(value=>value.messageId==='71');const reference={claimedSender:{},referenceMessageId:identifier('im.message','71'),parts:[]}
 assert.equal((await f.transport.sendForwardNodes(f.scope('90000101'),[reference],signal())).code,'rejected')
 assert.equal((await f.transport.sendForwardNodes(f.scope(),[reference],signal())).status,'accepted');assert.deepEqual(sent(f)[0].params.messages,[{type:'node',data:{id:'71'}}])
 now+=101;assert.equal((await f.transport.sendForwardNodes(f.scope(),[reference],signal())).code,'rejected')
 for(const part of[{type:'file',attachmentId:'no-grant',name:'original.html'},{type:'forward',resourceId:'not-expanded'},{type:'unsupported',segmentType:'unknown'}])assert.equal((await f.transport.sendForwardNodes(f.scope(),[node(),node([part])],signal())).code,'rejected')
 assert.equal(sent(f).length,1)
})

test('depth, per-node cumulative text and attachment scope limits reject whole writes',options,async t=>{
 const f=await fixture(t,{config:{maxForwardDepth:1,maxForwardNodes:2,maxTextChars:8,allowedGroups:['90000100','90000101']}});await f.ready()
 for(const nodes of[[node([{type:'text',text:'12345'},{type:'text',text:'6789'}])],[node([{type:'inline-forward',node:node()}])],[node(),node(),node()]])assert.equal((await f.transport.sendForwardNodes(f.scope(),nodes,signal())).code,'rejected')
 const id=f.transport.registerMedia(f.scope('90000101'),'image',Buffer.from('complete'));assert.equal((await f.transport.sendForwardNodes(f.scope(),[node([{type:'image',attachmentId:id}])],signal())).code,'rejected');assert.equal(sent(f).length,0)
})

test('cached normalized snapshots retain original attachment handles without publishing again',options,async t=>{
 const f=await fixture(t,{config:{allowedGroups:['90000100','90000101']}});await f.ready();f.peer.send(JSON.stringify(message({message_id:72,message:[{type:'image',data:{url:'https://example.invalid/original.gif'}}]})));const received=await f.message(value=>value.messageId==='72'),snapshot=f.transport.messageSnapshot(f.scope(),identifier('im.message','72'))
 assert.deepEqual(snapshot,received);snapshot.parts[0].attachmentId='mutated';assert.equal(f.transport.messageSnapshot(f.scope(),identifier('im.message','72')).parts[0].attachmentId,received.parts[0].attachmentId);assert.equal(f.transport.messageSnapshot(f.scope('90000101'),identifier('im.message','72')),undefined);assert.equal(f.messages.length,1);assert.equal(f.requests.some(value=>value.action==='get_msg'),false)
})

test('a durable resolver sees only a sole forward part; ordinary messages and mixed parts retain their policy',options,async t=>{
 const f=await fixture(t);await f.ready();const seen=[],release=f.transport.registerForwardDispatcher({async send(scope,id,abort){seen.push({scope,id,aborted:abort.aborted});return{status:'accepted',messageIds:[identifier('im.message','81')]}}})
 assert.throws(()=>f.transport.registerForwardDispatcher({send:async()=>({status:'failed',code:'rejected'})}))
 assert.equal((await f.transport.send(f.outbound([{type:'forward',resourceId:identifier('im.forward','prepared-output')}]),signal())).status,'accepted');assert.equal(seen.length,1);assert.equal(seen[0].id,'prepared-output')
 assert.equal((await f.transport.send(f.outbound([{type:'text',text:'ordinary'}]),signal())).status,'accepted');assert.equal((await f.transport.send(f.outbound([{type:'text',text:'mixed'},{type:'forward',resourceId:'prepared-output'}]),signal())).code,'rejected');assert.equal(seen.length,1);await release();await release();assert.equal((await f.transport.send(f.outbound([{type:'forward',resourceId:'prepared-output'}]),signal())).code,'unavailable')
})

test('resolver disposal aborts and joins actual cleanup while refusing replacement until it settles',options,async t=>{
 const f=await fixture(t);await f.ready();const entered=deferred(),aborted=deferred(),cleanup=deferred();let calls=0
 const release=f.transport.registerForwardDispatcher({async send(scope,id,abort){calls++;abort.addEventListener('abort',()=>aborted.resolve(),{once:true});entered.resolve();await cleanup.promise;return{status:'uncertain',code:'cancelled-after-dispatch'}}}),pending=f.transport.send(f.outbound([{type:'forward',resourceId:'prepared-output'}]),signal());await entered.promise;let disposed=false;const closing=release().then(()=>{disposed=true});await aborted.promise;assert.equal(disposed,false);assert.throws(()=>f.transport.registerForwardDispatcher({send:async()=>({status:'failed',code:'rejected'})}));assert.equal((await f.transport.send(f.outbound([{type:'forward',resourceId:'prepared-output'}]),signal())).code,'unavailable');cleanup.resolve();await closing;assert.equal((await pending).status,'uncertain');assert.equal(calls,1)
})

test('backend timeout after merged dispatch is uncertain and never retried',options,async t=>{
 const f=await fixture(t,{config:{actionTimeoutMs:30},intercept(peer,request){return request.action==='send_group_forward_msg'}});await f.ready();assert.deepEqual(await f.transport.sendForwardNodes(f.scope(),[node()],signal()),{status:'uncertain',code:'timeout'});assert.equal(sent(f).length,1)
})

test('muted targets do not invoke either node serialization or a retained-output resolver',options,async t=>{
 const f=await fixture(t,{intercept(peer,request){if(request.action==='get_group_member_info'){reply(peer,request,{user_id:90000001,role:'member',shut_up_timestamp:Date.now()/1000+600});return true}}});await f.ready();let calls=0;f.transport.registerForwardDispatcher({async send(){calls++;return{status:'accepted',messageIds:['83']}}});assert.equal((await f.transport.sendForwardNodes(f.scope(),[node()],signal())).code,'muted');assert.equal((await f.transport.send(f.outbound([{type:'forward',resourceId:'prepared-output'}]),signal())).code,'muted');assert.equal(calls,0);assert.equal(sent(f).length,0)
})
