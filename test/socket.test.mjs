import test from 'node:test'
import assert from 'node:assert/strict'
import {once} from 'node:events'
import {inspect} from 'node:util'
import {createServer} from 'node:http'
import WebSocket,{WebSocketServer} from 'ws'
import {OneBotSocket} from '../dist/socket.js'
import {spec,deferred} from './helpers.mjs'

function stack(t){
 const cleanups=[]
 t.after(async()=>{const errors=[];for(const fn of cleanups.reverse())try{await fn()}catch(error){errors.push(error)}if(errors.length)throw new AggregateError(errors)})
 return cleanup=>cleanups.push(cleanup)
}
async function forwardFixture(t,overrides={},handler,configure=value=>value){
 const own=stack(t),server=new WebSocketServer({host:'127.0.0.1',port:0})
 own(()=>new Promise(resolve=>{for(const client of server.clients)client.terminate();server.close(resolve)}))
 await once(server,'listening')
 const connected=deferred(),peer=deferred(),events=[],faults=[],requests=[],authorizations=[]
 server.on('connection',(socket,upgrade)=>{authorizations.push(upgrade.headers.authorization);peer.resolve(socket);socket.on('message',data=>{const request=JSON.parse(data.toString());requests.push(request);handler?.(socket,request,requests)})})
 const transport=new OneBotSocket(configure(spec({forwardUrl:'ws://127.0.0.1:'+server.address().port,...overrides})),{event:value=>events.push(value),connection:value=>{if(value)connected.resolve()},fault:code=>faults.push(code)})
 own(()=>transport.close())
 await transport.start();await connected.promise
 return {transport,server,peer:await peer.promise,events,faults,requests,authorizations,own}
}
function reply(peer,request,data={ok:true}){peer.send(JSON.stringify({status:'ok',retcode:0,data,echo:request.echo}))}

test('forward WebSocket authenticates and correlates out-of-order actions',{timeout:30000},async t=>{
 const got=deferred()
 const f=await forwardFixture(t,{},(_peer,_request,requests)=>{if(requests.length===2)got.resolve()})
 const first=f.transport.call('first',{},new AbortController().signal)
 const second=f.transport.call('second',{},new AbortController().signal)
 await got.promise
 reply(f.peer,f.requests[1],{which:2});reply(f.peer,f.requests[0],{which:1})
 assert.deepEqual(await first,{kind:'ok',data:{which:1}})
 assert.deepEqual(await second,{kind:'ok',data:{which:2}})
 assert.notEqual(f.requests[0].echo,f.requests[1].echo)
 assert.deepEqual(f.authorizations,['Bearer fixture-only-token'])
 assert.ok(!JSON.stringify(f.transport).includes('fixture-only-token'))
 assert.ok(!inspect(f.transport).includes('fixture-only-token'))
 assert.ok(!inspect(f.transport).includes('127.0.0.1'))
})

test('a fresh credential is resolved for every forward reconnection',{timeout:30000},async t=>{
 let token='first-fixture-token',reads=0
 const f=await forwardFixture(t,{},undefined,config=>({...config,accessToken:async()=>{reads++;return token}}))
 assert.deepEqual(f.authorizations,['Bearer first-fixture-token'])
 token='second-fixture-token'
 const reconnected=once(f.server,'connection');f.peer.terminate()
 await reconnected
 assert.deepEqual(f.authorizations,['Bearer first-fixture-token','Bearer second-fixture-token'])
 assert.equal(reads,2)
})

test('reverse shutdown cancels pending credential resolution and closes the upgrading socket',{timeout:30000},async t=>{
 const own=stack(t),started=deferred(),pending=deferred()
 const config=spec({mode:'reverse',reversePort:0})
 const transport=new OneBotSocket({...config,accessToken:async()=>{started.resolve();return pending.promise}},{event:()=>{},connection:()=>{},fault:()=>{}})
 own(()=>transport.close());await transport.start()
 const peer=new WebSocket('ws://127.0.0.1:'+transport.port+'/onebot',{headers:{Authorization:'Bearer fixture-only-token'}})
 peer.on('error',()=>{});const closed=new Promise(resolve=>peer.once('close',resolve))
 own(async()=>{peer.terminate();await closed})
 await started.promise;await transport.close();await closed
 pending.resolve('late-fixture-token')
 assert.equal(transport.connected,false)
})
test('timeouts are uncertain and late replies cannot fulfill another action',{timeout:30000},async t=>{
 const got=deferred()
 const f=await forwardFixture(t,{actionTimeoutMs:30},()=>got.resolve())
 const first=f.transport.call('send_group_msg',{group_id:90000100},new AbortController().signal)
 await got.promise
 assert.deepEqual(await first,{kind:'uncertain',code:'timeout'})
 assert.equal(f.requests.length,1)
 const request2=deferred()
 f.peer.on('message',()=>{if(f.requests.length===2)request2.resolve()})
 const second=f.transport.call('get_status',{},new AbortController().signal)
 await request2.promise
 reply(f.peer,f.requests[0],{stale:true});reply(f.peer,f.requests[1],{fresh:true})
 assert.deepEqual(await second,{kind:'ok',data:{fresh:true}})
})
test('pending action capacity and caller cancellation do not create retries',{timeout:30000},async t=>{
 const got=deferred(),control=new AbortController()
 const f=await forwardFixture(t,{maxPendingActions:1},()=>got.resolve())
 const pending=f.transport.call('send_group_msg',{},control.signal)
 await got.promise
 assert.deepEqual(await f.transport.call('send_group_msg',{},new AbortController().signal),{kind:'not-sent',code:'busy'})
 control.abort()
 assert.deepEqual(await pending,{kind:'uncertain',code:'cancelled'})
 assert.equal(f.requests.length,1)
 const stopped=f.transport.close()
 assert.equal(stopped,f.transport.close())
 await stopped
 assert.deepEqual(await f.transport.call('get_status',{},new AbortController().signal),{kind:'not-sent',code:'cancelled'})
})
test('invalid and oversized outgoing payloads fail before any dispatch',{timeout:30000},async t=>{
 const f=await forwardFixture(t,{maxFrameBytes:1024})
 const cyclic={};cyclic.self=cyclic
 assert.deepEqual(await f.transport.call('bad',cyclic,new AbortController().signal),{kind:'not-sent',code:'invalid'})
 assert.deepEqual(await f.transport.call('large',{text:'x'.repeat(2000)},new AbortController().signal),{kind:'not-sent',code:'too-large'})
 const control=new AbortController();control.abort()
 assert.deepEqual(await f.transport.call('cancelled',{},control.signal),{kind:'not-sent',code:'cancelled'})
 assert.equal(f.requests.length,0)
})
test('a closed peer leaves dispatched actions uncertain',{timeout:30000},async t=>{
 const got=deferred()
 const f=await forwardFixture(t,{},()=>got.resolve())
 const pending=f.transport.call('send_group_msg',{},new AbortController().signal)
 await got.promise
 f.peer.terminate()
 assert.deepEqual(await pending,{kind:'uncertain',code:'closed'})
 assert.equal(f.requests.length,1)
})

test('an exception from the socket send call cannot claim the operation was never dispatched',{timeout:30000},async t=>{
 const f=await forwardFixture(t)
 const socket=f.transport.session.socket,original=socket.send
 socket.send=()=>{throw new Error('synthetic sender failure')}
 try{assert.deepEqual(await f.transport.call('send_group_msg',{},new AbortController().signal),{kind:'uncertain',code:'send-error'})}finally{socket.send=original}
})
test('reverse universal sockets reject unauthorized peers without exposing credentials',{timeout:30000},async t=>{
 const own=stack(t),connected=deferred(),events=deferred()
 const transport=new OneBotSocket(spec({mode:'reverse',reversePort:0}),{event:value=>events.resolve(value),connection:up=>{if(up)connected.resolve()},fault:()=>{}})
 own(()=>transport.close());await transport.start()
 const rejected=new WebSocket('ws://127.0.0.1:'+transport.port+'/onebot',{headers:{Authorization:'Bearer incorrect'}})
 const rejectedDone=new Promise(resolve=>rejected.once('close',resolve));rejected.on('error',()=>{})
 own(async()=>{rejected.terminate();await rejectedDone})
 const denied=deferred()
 rejected.once('unexpected-response',(_request,response)=>{denied.resolve(response.statusCode);response.resume();rejected.terminate()})
 assert.equal(await denied.promise,403)
 const peer=new WebSocket('ws://127.0.0.1:'+transport.port+'/onebot',{headers:{Authorization:'Bearer fixture-only-token','X-Self-ID':'90000001','X-Client-Role':'Universal'}})
 const peerDone=new Promise(resolve=>peer.once('close',resolve));peer.on('error',()=>{})
 own(async()=>{peer.terminate();await peerDone})
 await once(peer,'open');await connected.promise
 peer.send(JSON.stringify({post_type:'meta_event',test:true}))
 assert.deepEqual(await events.promise,{post_type:'meta_event',test:true})
 const request=deferred()
 peer.once('message',data=>request.resolve(JSON.parse(data.toString())))
 const pending=transport.call('get_status',{},new AbortController().signal)
 const frame=await request.promise;reply(peer,frame,{online:true,good:true})
 assert.deepEqual(await pending,{kind:'ok',data:{online:true,good:true}})
 await transport.close()
 assert.equal(transport.connected,false)
})
test('forward authorization rejection terminates its dial loop instead of retrying',{timeout:30000},async t=>{
 const own=stack(t),http=createServer(),denied=deferred(),stopped=deferred()
 let attempts=0
 http.on('upgrade',(_request,socket)=>{attempts++;socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')})
 own(()=>new Promise(resolve=>{http.close(resolve);http.closeAllConnections()}))
 http.listen(0,'127.0.0.1');await once(http,'listening')
 const transport=new OneBotSocket(spec({forwardUrl:'ws://127.0.0.1:'+http.address().port}),{event:()=>{},connection:()=>{},fault:code=>{if(code==='authentication-rejected')denied.resolve()},stopped:()=>stopped.resolve()})
 own(()=>transport.close());await transport.start();await denied.promise;await stopped.promise
 assert.equal(attempts,1)
 assert.equal(transport.connected,false)
 assert.equal(transport.lastFault,'authentication-rejected')
})
