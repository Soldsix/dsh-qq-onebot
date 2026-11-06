import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {once} from 'node:events'
import {WebSocketServer} from 'ws'
import {identifier} from 'dsh-im-kit'
import * as Plugin from '../dist/index.js'
import {deferred,message} from './helpers.mjs'

const options={timeout:30000}

async function context(t,read=async()=>({value:'fixture-only-token',source:'test'})){
 const ctx=new Context(),fibers=[]
 t.after(async()=>{const failures=[];for(const fiber of fibers.reverse())try{await fiber.dispose()}catch(error){failures.push(error)}if(failures.length)throw new AggregateError(failures)})
 const credentials=ctx.plugin({name:'onebot-test-credentials',apply(ctx){ctx.effect(()=>ctx.provide('credentials',{resolve:read}))}})
 fibers.push(credentials);await credentials.await()
 const mount=async(plugin,config)=>{const fiber=ctx.plugin(plugin,config);fibers.push(fiber);await fiber.await();return fiber}
 return {ctx,mount}
}

test('the disabled bundle opens no account service and performs no credential reads',options,async t=>{
 let calls=0
 const {ctx,mount}=await context(t,async()=>{calls++;throw Error('should not resolve')})
 const owner=await mount(Plugin,Plugin.Config({}))
 assert.equal(calls,0)
 assert.equal(ctx.get('im'),undefined)
 assert.equal(ctx.get('qqOnebot'),undefined)
 await owner.dispose()
})

test('a stalled credential provider cannot hold profile startup indefinitely',options,async t=>{
 const pending=deferred()
 const {ctx,mount}=await context(t,()=>pending.promise)
 await assert.rejects(mount(Plugin,Plugin.Config({enabled:true,accountId:'90000001',connectTimeoutMs:50})),/OneBot credential lookup failed/)
 assert.equal(ctx.get('im'),undefined)
 assert.equal(ctx.get('qqOnebot'),undefined)
 pending.resolve({value:'late-fixture-token',source:'test'})
})

test('a Cordis consumer receives and sends through the bundle and unloads with it',options,async t=>{
 const server=new WebSocketServer({host:'127.0.0.1',port:0}),peer=deferred(),online=deferred(),received=deferred(),aborted=deferred(),sent=deferred(),sendCompleted=deferred()
 t.after(()=>new Promise(resolve=>{for(const client of server.clients)client.terminate();server.close(resolve)}))
 await once(server,'listening')
 server.on('connection',socket=>{
  peer.resolve(socket)
  socket.on('message',raw=>{
   const request=JSON.parse(raw.toString())
   let data
   if(request.action==='get_login_info')data={user_id:90000001}
   else if(request.action==='get_status')data={online:true,good:true}
   else if(request.action==='get_group_member_info')data={user_id:90000001,role:'member',shut_up_timestamp:0}
   else {data={message_id:102};sent.resolve(request)}
   socket.send(JSON.stringify({status:'ok',retcode:0,data,echo:request.echo}))
  })
 })
 const {ctx,mount}=await context(t)
 await mount({name:'onebot-test-status',apply(ctx){ctx.on('qq-onebot/status',state=>{if(state.online)online.resolve()})}})
 const owner=await mount(Plugin,Plugin.Config({enabled:true,accountId:'90000001',allowedGroups:['90000100'],forwardUrl:'ws://127.0.0.1:'+server.address().port}))
 await online.promise
 const consumer=await mount({name:'onebot-test-consumer',inject:['im','qqOnebot'],apply(ctx){
  ctx.effect(()=>ctx.im.subscribe(async(value,signal)=>{
   received.resolve(value)
   const result=await ctx.im.send({scope:value.scope,operationId:identifier('im.operation','onebot-plugin-test'),parts:[{type:'reply',messageId:value.messageId},{type:'text',text:'local-only reply'}]},signal)
   if(result.status!=='accepted'){sendCompleted.reject(new Error('Expected send acceptance, got '+result.status));return}
   const cancelled=new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))
   sendCompleted.resolve();await cancelled;aborted.resolve()
  },()=>true))
 }})
 const socket=await peer.promise;socket.send(JSON.stringify(message()))
 assert.equal((await received.promise).directedToBot,false)
 const outgoing=await sent.promise
 assert.equal(outgoing.action,'send_group_msg')
 assert.deepEqual(outgoing.params.message,[{type:'reply',data:{id:'10'}},{type:'text',data:{text:'local-only reply'}}])
 await sendCompleted.promise
 const transport=ctx.qqOnebot
 await owner.dispose();await aborted.promise
 assert.equal(transport.status().phase,'stopped')
 assert.equal(ctx.get('im'),undefined)
 assert.equal(ctx.get('qqOnebot'),undefined)
 await consumer.dispose()
})
