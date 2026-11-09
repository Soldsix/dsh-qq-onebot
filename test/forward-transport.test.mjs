/** Scoped single-flight reads use real loopback OneBot frames without contacting QQ. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {once} from 'node:events'
import {identifier} from 'dsh-im-kit'
import {fixture,reply} from './transport-fixture.mjs'
import {message,deferred} from './helpers.mjs'
const signal=()=>new AbortController().signal,mid=value=>identifier('im.message',value),fid=value=>identifier('im.forward',value),text=value=>({type:'text',data:{text:value}})
const nodes=(content=[text('exact original')])=>({messages:[{sender:{user_id:90000001,nickname:'claimed sender'},time:1000,message_id:-8,group_id:99999999,content}]})
async function root(f,id='51',resources=['root-resource']){f.peer.send(JSON.stringify(message({message_id:Number(id),message:resources.map(id=>({type:'forward',data:{id}}))})));await f.message(value=>value.messageId===id);return mid(id)}
const read=(f,id,resource='root-resource',abort=signal(),scope=f.scope())=>f.transport.readForward(scope,id,fid(resource),abort)
const options={timeout:30000}

test('outer message grants, child grants and media never move to returned group IDs or another scope',options,async t=>{
 const f=await fixture(t,{config:{allowedGroups:['90000100','90000101']},intercept(peer,request){if(request.action==='get_forward_msg'){reply(peer,request,request.params.id==='root-resource'?nodes([text('before'),{type:'reply',data:{id:'-12'}},{type:'image',data:{url:'https://example.invalid/full.png'}},{type:'forward',data:{id:'nested-resource'}}]):nodes([text('nested')]));return true}}});await f.ready();const id=await root(f)
 for(const destination of[f.scope('90000101'),f.scope('90000100','private'),{...f.scope(),account:{...f.scope().account,accountId:'90000009'}}])assert.notEqual((await read(f,id,'root-resource',signal(),destination)).status,'resolved')
 assert.deepEqual(await read(f,id,'nested-resource'),{status:'failed',code:'not-found'});assert.equal(f.requests.filter(value=>value.action==='get_forward_msg').length,0)
 const result=await read(f,id);assert.equal(result.status,'resolved');assert.equal(result.scope.peerId,'90000100');assert.equal(result.nodes[0].claimedSender.id,'90000001');assert.equal(result.nodes[0].parts[1].messageId,'-12');const media=result.nodes[0].parts[2].attachmentId;assert.equal(f.transport.mediaSource(f.scope(),media).url,'https://example.invalid/full.png');assert.equal(f.transport.mediaSource(f.scope('90000101'),media),undefined)
 result.nodes[0].parts[0].text='caller mutation';result.raw.messages=[];assert.equal((await read(f,id)).nodes[0].parts[0].text,'before');assert.equal((await read(f,id)).raw.messages.length,1);assert.equal((await read(f,id,'nested-resource')).nodes[0].parts[0].text,'nested');assert.equal(f.messages.length,1);assert.equal(f.requests.filter(value=>value.action==='get_forward_msg').length,2)
})

test('one cancelled waiter does not abort another reader or duplicate the protocol request',options,async t=>{
 const entered=deferred();let held
 const f=await fixture(t,{intercept(peer,request){if(request.action==='get_forward_msg'){held={peer,request};entered.resolve();return true}}});await f.ready();const id=await root(f),cancel=new AbortController(),first=read(f,id,'root-resource',cancel.signal),second=read(f,id);await entered.promise
 cancel.abort();assert.deepEqual(await first,{status:'failed',code:'cancelled'});assert.equal(f.requests.filter(value=>value.action==='get_forward_msg').length,1);reply(held.peer,held.request,nodes());assert.equal((await second).status,'resolved');assert.equal((await read(f,id)).status,'resolved');assert.equal(f.requests.filter(value=>value.action==='get_forward_msg').length,1)
})

test('last-waiter cancellation frees the call and a late response cannot replace a later result',options,async t=>{
 const entered=deferred();let old,calls=0
 const f=await fixture(t,{intercept(peer,request){if(request.action==='get_forward_msg'){if(++calls===1){old={peer,request};entered.resolve()}else{reply(old.peer,old.request,nodes([text('old stale data')]));reply(peer,request,nodes([text('new retained data')]))}return true}}});await f.ready();const id=await root(f),cancel=new AbortController(),pending=read(f,id,'root-resource',cancel.signal);await entered.promise;cancel.abort();assert.equal((await pending).code,'cancelled');assert.equal((await read(f,id)).nodes[0].parts[0].text,'new retained data');assert.equal((await read(f,id)).nodes[0].parts[0].text,'new retained data');assert.equal(calls,2)
})

test('a held read pins its root, refreshes successful retention and expires sources together',options,async t=>{
 let now=1000,held;const entered=deferred()
 const f=await fixture(t,{now:()=>now,config:{referenceTtlMs:100,maxReferences:1,onlineStaleMs:10000},intercept(peer,request){if(request.action==='get_forward_msg'){held={peer,request};entered.resolve();return true}}});await f.ready();const id=await root(f),pending=read(f,id);await entered.promise;now+=200;assert.ok(f.transport.original(f.scope(),id));f.peer.send(JSON.stringify(message({message_id:52})));await f.state(value=>value.rejected===1);assert.ok(f.transport.original(f.scope(),id));reply(held.peer,held.request,nodes([{type:'image',data:{url:'https://example.invalid/original.gif'}}]));const result=await pending;assert.equal(result.status,'resolved');const attachment=result.nodes[0].parts[0].attachmentId;assert.ok(f.transport.mediaSource(f.scope(),attachment));now+=101;assert.equal(f.transport.mediaSource(f.scope(),attachment),undefined);assert.equal(f.transport.original(f.scope(),id),undefined);assert.equal((await read(f,id)).code,'not-found')
})

test('forward quotas reject excess work while ordinary receipt and send paths continue',options,async t=>{
 let held;const entered=deferred(),f=await fixture(t,{config:{maxForwardCalls:1},intercept(peer,request){if(request.action==='get_forward_msg'){held={peer,request};entered.resolve();return true}}});await f.ready();const id=await root(f,'51',['one','two']),pending=read(f,id,'one');await entered.promise
 assert.deepEqual(await read(f,id,'two'),{status:'failed',code:'capacity'});f.peer.send(JSON.stringify(message({message_id:53})));await f.message(value=>value.messageId==='53');assert.equal((await f.transport.send(f.outbound(),signal())).status,'accepted');reply(held.peer,held.request,nodes());assert.equal((await pending).status,'resolved')
})

test('node, resource and byte limits retain no partial media or child grants',options,async t=>{
 for(const [config,response]of[[{maxForwardNodes:1},{messages:[...nodes().messages,...nodes().messages]}],[{maxForwardResources:1},nodes([{type:'forward',data:{id:'child'}},{type:'image',data:{url:'https://example.invalid/not-retained.png'}}])],[{maxReferenceBytes:1024},nodes([text('large '.repeat(300))])]]){
  const f=await fixture(t,{config,intercept(peer,request){if(request.action==='get_forward_msg'){reply(peer,request,response);return true}}});await f.ready();const id=await root(f);assert.deepEqual(await read(f,id),{status:'failed',code:'capacity'});assert.deepEqual(await read(f,id,'child'),{status:'failed',code:'not-found'});assert.equal(f.transport.status().storedReferences,1);await f.transport.dispose()
 }
})

test('malformed, rejected and timed-out reads stay failures and are never automatically retried',options,async t=>{
 for(const kind of['malformed','rejected','timeout']){
  const f=await fixture(t,{config:{actionTimeoutMs:1000},intercept(peer,request){if(request.action==='get_forward_msg'){if(kind==='malformed')reply(peer,request,{messages:[{content:[text('a')],message:[text('b')]}]});else if(kind==='rejected')peer.send(JSON.stringify({status:'failed',retcode:1404,data:null,echo:request.echo}));return true}}});await f.ready();const id=await root(f);assert.deepEqual(await read(f,id),{status:'failed',code:kind});assert.equal(f.requests.filter(value=>value.action==='get_forward_msg').length,1);await f.transport.dispose()
 }
})

test('disconnect cancels the old generation without caching it into the new connection',options,async t=>{
 const entered=deferred();let calls=0
 const f=await fixture(t,{intercept(peer,request){if(request.action==='get_forward_msg'){if(++calls===1)entered.resolve();else reply(peer,request,nodes([text('new generation')]));return true}}});await f.ready();const id=await root(f),pending=read(f,id);await entered.promise;const reconnected=once(f.server,'connection');f.peer.terminate();await reconnected;await f.state(value=>value.online);assert.notEqual((await pending).status,'resolved');assert.equal((await read(f,id)).nodes[0].parts[0].text,'new generation');assert.equal(calls,2)
})

test('disposing a held reader joins its local call and leaves no active callback or source',options,async t=>{
 const entered=deferred(),f=await fixture(t,{intercept(peer,request){if(request.action==='get_forward_msg'){entered.resolve();return true}}});await f.ready();const id=await root(f),pending=read(f,id);await entered.promise;await f.transport.dispose();assert.equal((await pending).code,'cancelled');assert.equal(f.transport.status().phase,'stopped');assert.equal(f.transport.original(f.scope(),id),undefined);assert.deepEqual(await read(f,id),{status:'failed',code:'cancelled'})
})

test('identical resource and outer IDs keep independent group and private attachment grants',options,async t=>{
 const f=await fixture(t,{config:{allowedGroups:['90000100','90000101']},intercept(peer,request){if(request.action==='get_forward_msg'){reply(peer,request,nodes([{type:'image',data:{url:'https://example.invalid/same-original.png'}}]));return true}}});await f.ready()
 const scopes=[f.scope(),f.scope('90000101'),f.scope('90000100','private')]
 for(const scope of scopes)f.peer.send(JSON.stringify(message({message_id:61,message_type:scope.kind,group_id:Number(scope.peerId),user_id:scope.kind==='private'?Number(scope.peerId):90000002,message:[{type:'forward',data:{id:'same-resource'}}]})))
 for(const scope of scopes)await f.message(value=>value.messageId==='61'&&value.scope.kind===scope.kind&&value.scope.peerId===scope.peerId)
 const results=await Promise.all(scopes.map(scope=>read(f,mid('61'),'same-resource',signal(),scope)));assert.ok(results.every(value=>value.status==='resolved'));assert.equal(new Set(results.map(value=>value.nodes[0].parts[0].attachmentId)).size,3)
 for(const [index,result]of results.entries())for(const [other,scope]of scopes.entries())assert.equal(Boolean(f.transport.mediaSource(scope,result.nodes[0].parts[0].attachmentId)),index===other)
 assert.equal(f.requests.filter(value=>value.action==='get_forward_msg').length,3)
})
