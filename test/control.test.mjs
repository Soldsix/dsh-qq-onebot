import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {Config as TransportConfig,validateConfig} from '../dist/config.js'
import Control,{Config as ControlConfig} from '../dist/control.js'
import {configRevision} from '../dist/config-revision.js'
import {CONFIG_FIELDS} from '../dist/config-fields.js'
import {draftPatch,fieldValue} from '../dist/config-draft.js'
import {deferred} from './helpers.mjs'

const options={timeout:30000}
const rejected=reason=>error=>error.code==='qq-onebot/control'&&error.details.reason===reason&&!error.message.includes('fixture-private')

async function mount(t,{configured=true,editFailure=false,describe}={}){
 const ctx=new Context(),fibers=[],writes=[]
 const entry={options:{id:'qq-onebot-transport',name:'dsh-qq-onebot',config:{enabled:false}},disabled:false,fiber:{config:{enabled:false},effectiveConfig:TransportConfig({}),state:2,restarts:0,async restart(){this.restarts++}}}
 const info={configured}
 const editor={
  entries:()=>[entry],configuration:()=>[{entry,inherited:{enabled:false},override:{allowedGroups:['90000100']}}],
  async edit(target,change){
   assert.equal(target,entry)
   if(editFailure)throw Error('fixture-private endpoint and secret must not cross Remote')
   const raw=change(structuredClone(entry.options.config),{enabled:false})
   writes.push(raw);entry.options.config=raw;entry.fiber.config=raw;entry.fiber.effectiveConfig=TransportConfig(raw)
  },
 }
 const services=ctx.plugin({name:'control-test-services',apply(ctx){
  ctx.effect(()=>ctx.provide('configEditor',editor))
  ctx.effect(()=>ctx.provide('credentials',{describe:describe??(async()=>info),resolve:async()=>{throw Error('Control must never resolve secret values')}}))
 }})
 fibers.push(services);await services.await()
 const fiber=ctx.plugin(Control,ControlConfig({}));fibers.push(fiber);await fiber.await()
 t.after(async()=>{for(const fiber of fibers.reverse())await fiber.dispose()})
 return {ctx,control:ctx.qqOnebotControl,entry,info,writes,editor,fiber}
}

test('every public config field has a page descriptor and its applied revision excludes runtime secrets',()=>{
 const config=TransportConfig({})
 assert.deepEqual(Object.keys(CONFIG_FIELDS).sort(),Object.keys(config).sort())
 assert.equal(configRevision({...config,accessToken:()=> 'fixture-private',account:{accountId:'ignored'}}),configRevision(config))
 assert.notEqual(configRevision({...config,maxSegments:config.maxSegments+1}),configRevision(config))
})

test('disabled incomplete drafts validate without credential access and malformed supplied fields still fail',()=>{
 validateConfig(TransportConfig({accountId:'',forwardUrl:'',accessTokenEnv:'',reversePath:''}))
 for(const draft of [{accountId:'01'},{allowedGroups:['1','1']},{forwardUrl:'wss://name:fixture-private@example.invalid'},{accessTokenEnv:'bad-name'},{reconnectMinMs:200,reconnectMaxMs:20}])assert.throws(()=>validateConfig(TransportConfig(draft)),error=>!error.message.includes('fixture-private'))
 assert.throws(()=>validateConfig(TransportConfig({enabled:true,accountId:''})))
})

test('owner snapshots show credential presence and detached config without resolving the secret',options,async t=>{
 const {control,entry}=await mount(t)
 const snapshot=await control.describe()
 assert.equal(snapshot.config.enabled,false);assert.equal(snapshot.status,null);assert.equal(snapshot.appliedRevision,null)
 assert.equal(snapshot.entryActive,true);assert.equal(snapshot.credential,'configured')
 assert.deepEqual(snapshot.overriddenFields,['allowedGroups'])
 snapshot.config.allowedGroups.push('2');assert.deepEqual(entry.fiber.effectiveConfig.allowedGroups,[])
 assert.equal(snapshot.refreshMs,3000)
})

test('saving sends only an admitted patch and rejects stale or invalid edits without a write',options,async t=>{
 const {control,writes}=await mount(t)
 const before=await control.describe()
 const after=await control.save({revision:before.revision,patch:{accountId:'90000001',allowedGroups:['90000100']}})
 assert.notEqual(before.revision,after.revision);assert.equal(writes.length,1)
 await assert.rejects(control.save({revision:before.revision,patch:{enabled:true}}),rejected('revision-conflict'))
 for(const patch of [{accessToken:'fixture-private'},{__x:'bad'},{maxSegments:'12'},{maxSegments:0},{mode:'wrong'},{allowedGroups:['90000100','90000100']},{forwardUrl:'ws://remote.invalid'}]){
  await assert.rejects(async()=>control.save({revision:after.revision,patch}),error=>['request-invalid','config-invalid'].includes(error.details?.reason))
 }
 assert.equal(writes.length,1)
 await assert.rejects(async()=>control.save({revision:after.revision,patch:{},target:'other-plugin'}),rejected('request-invalid'))
})

test('missing credentials refuse activation but still allow saving a disabled draft',options,async t=>{
 const {control,writes}=await mount(t,{configured:false})
 const before=await control.describe()
 await assert.rejects(control.save({revision:before.revision,patch:{enabled:true,accountId:'90000001'}}),rejected('credentials-missing'))
 assert.equal(writes.length,0)
 const next=await control.save({revision:before.revision,patch:{accountId:'90000001'}})
 assert.equal(next.credential,'missing');assert.equal(writes.length,1)
})

test('native editor failure is sanitized and does not report a successful save',options,async t=>{
 const {control,writes}=await mount(t,{editFailure:true})
 const before=await control.describe()
 await assert.rejects(control.save({revision:before.revision,patch:{accountId:'90000001'}}),rejected('apply-failed'))
 assert.equal(writes.length,0);assert.equal((await control.describe()).revision,before.revision)
})

test('reconnect uses only saved config and optimistic revision, never an arbitrary entry',options,async t=>{
 const {control,entry,writes}=await mount(t)
 let snapshot=await control.describe()
 await assert.rejects(control.restart({revision:snapshot.revision}),rejected('entry-unavailable'))
 snapshot=await control.save({revision:snapshot.revision,patch:{enabled:true,accountId:'90000001'}})
 await assert.rejects(async()=>control.restart({revision:snapshot.revision,patch:{accountId:'2'}}),rejected('request-invalid'))
 await control.restart({revision:snapshot.revision})
 assert.equal(entry.fiber.restarts,1);assert.equal(writes.length,1)
 entry.options.name='other-plugin'
 await assert.rejects(control.describe(),rejected('entry-unavailable'))
})

test('disposing control cancels a stalled presence query and waits for its tracked operation',options,async t=>{
 const pending=deferred(),{control,fiber}=await mount(t,{describe:()=>pending.promise})
 const read=control.describe();await Promise.resolve();await fiber.dispose()
 assert.equal((await read).credential,'unavailable')
 assert.throws(()=>control.describe(),rejected('cancelled'))
 pending.resolve({configured:true,writable:false})
})

test('native draft parsing sends changed values only and refuses blank or fractional integer inputs',()=>{
 const config=TransportConfig({allowedGroups:['90000100']})
 assert.deepEqual(draftPatch({accountId:'',allowedGroups:'90000100',maxSegments:'256'},config),{ok:true,patch:{}})
 assert.deepEqual(draftPatch({allowedGroups:'1, 2\n3，4',enabled:true},config),{ok:true,patch:{allowedGroups:['1','2','3','4'],enabled:true}})
 for(const value of ['', '1.5', 'NaN', '9007199254740993'])assert.deepEqual(draftPatch({maxSegments:value},config),{ok:false,field:'maxSegments'})
 assert.equal(fieldValue(config,'allowedGroups'),'90000100')
 assert.equal(fieldValue(config,'enabled'),false)
})
