/** Native profile probe: transactional config, SRC gateway and real loopback transport. */
import assert from 'node:assert/strict'
import {readFile,writeFile,rename} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {setImmediate as nextTurn} from 'node:timers/promises'

export const name='onebot-control-host-probe'
export const inject=['qqOnebotControl','configEditor','typertGateway','remoteAccess']
async function record(path,data){await writeFile(path+'.tmp',JSON.stringify(data,null,2)+'\n');await rename(path+'.tmp',path)}
const hash=value=>createHash('sha256').update(value).digest('hex')

async function verify(ctx,config,checks){
 const controller=ctx.qqOnebotControl
 const controlUid=ctx.configEditor.entries().find(entry=>entry.options.id==='qq-onebot-control')?.fiber?.uid
 assert.ok(controlUid!==undefined)
 const lifetime=new AbortController()
 ctx.effect(()=>()=>lifetime.abort())
 const peer={id:'local-qa-owner',ctx,principal:{kind:'owner'},signal:lifetime.signal,interactions:'none',async dispose(){}}
 const invoke=(method,args={},caller=peer)=>ctx.typertGateway.invoke({namespace:'qqOnebotControl',method,args,peer:caller,signal:lifetime.signal})
 await record(config.readyPath,{control:true})
 const initial=await invoke('describe')
 assert.equal(initial.config.enabled,false);assert.equal(initial.status,null);assert.equal(initial.config.tenantId,'qa-tenant')
 checks.push('native-disabled-snapshot','src-gateway-discovery')
 try{
  await invoke('describe',{}, {...peer,id:'local-qa-guest',principal:{kind:'onebot-test-guest'}})
  assert.fail('Non-owner read was accepted')
 }catch(error){assert.notEqual(error.code,undefined);assert.notEqual(error.code,'ERR_ASSERTION');checks.push('non-owner-refused:'+error.code)}
 ctx.effect(()=>ctx.remoteAccess.registerPolicy('onebot-test-guest',{bindings:()=>[{resource:{kind:'global'},role:{name:'qa-global',resource:'global',actions:['qqOnebotControl/describe','qqOnebotControl/save','qqOnebotControl/restart']}}]}))
 const guest={...peer,id:'local-qa-permitted-guest',principal:{kind:'onebot-test-guest'}}
 for(const [method,args]of [['describe',{}],['save',{request:{revision:initial.revision,patch:{accountId:'2'}}}],['restart',{request:{revision:initial.revision}}]]){
  await assert.rejects(invoke(method,args,guest),error=>error.code==='qq-onebot/control'&&error.details.reason==='forbidden')
 }
 checks.push('controller-denies-non-owner-even-with-global-policy')
 const online=()=>new Promise((resolve,reject)=>{
  const signal=AbortSignal.any([lifetime.signal,AbortSignal.timeout(10000)])
  const done=value=>{off();signal.removeEventListener('abort',cancel);resolve(value)}
  const cancel=()=>{off();reject(signal.reason)}
  const off=ctx.on('qq-onebot/status',state=>{if(state.online)done(state)})
  signal.addEventListener('abort',cancel,{once:true})
  const current=ctx.get('qqOnebot')?.status();if(current?.online)done(current)
 })
 const beforeOnline=online()
 const enabled=await invoke('save',{request:{revision:initial.revision,patch:{enabled:true}}})
 assert.equal(enabled.config.enabled,true);assert.equal(enabled.appliedRevision,enabled.revision)
 await beforeOnline
 checks.push('native-profile-save-and-transport-remount','separate-online-verification')
 const body=await readFile(ctx.configEditor.documentPath,'utf8')
 assert.match(body,/!!js/)
 checks.push('unchanged-expression-preserved')
 await assert.rejects(invoke('save',{request:{revision:initial.revision,patch:{enabled:false}}}),error=>error.details?.reason==='revision-conflict')
 const fileHash=hash(await readFile(ctx.configEditor.documentPath))
 await assert.rejects(invoke('save',{request:{revision:enabled.revision,patch:{forwardUrl:'ws://unsafe.invalid'}}}),error=>error.details?.reason==='config-invalid')
 assert.equal(hash(await readFile(ctx.configEditor.documentPath)),fileHash)
 checks.push('stale-editor-refused','invalid-edit-not-persisted')
 const restarted=await invoke('restart',{request:{revision:enabled.revision}})
 assert.equal(restarted.appliedRevision,restarted.revision)
 await online()
 checks.push('awaited-fiber-reconnect')
 const disabled=await invoke('save',{request:{revision:restarted.revision,patch:{enabled:false}}})
 assert.equal(disabled.status,null);assert.equal(disabled.appliedRevision,null)
 assert.equal(ctx.configEditor.entries().find(entry=>entry.options.id==='qq-onebot-control')?.fiber?.uid,controlUid)
 assert.equal((await controller.describe()).revision,disabled.revision)
 checks.push('control-survives-transport-unload')
 const beforeFailure=hash(await readFile(ctx.configEditor.documentPath))
 await assert.rejects(invoke('save',{request:{revision:disabled.revision,patch:{enabled:true,mode:'reverse',reversePort:config.occupiedPort}}}),error=>error.details?.reason==='apply-failed')
 assert.equal(hash(await readFile(ctx.configEditor.documentPath)),beforeFailure)
 const restored=await invoke('describe')
 assert.equal(restored.config.enabled,false);assert.equal(restored.entryActive,true);assert.equal(restored.status,null)
 checks.push('native-editor-startup-failure-rollback')
 await record(config.resultPath,{passed:true,checks,modelRequests:0,qqMessagesSent:0})
}

export function apply(ctx,config){
 const lifetime=new AbortController()
 const checks=[]
 // Profile edits wait for loading fibers; run only after this probe's activation returns.
 const task=nextTurn(undefined,{signal:lifetime.signal}).then(()=>verify(ctx,config,checks)).catch(async error=>{
  if(!lifetime.signal.aborted)await record(config.resultPath,{passed:false,checks,error:{code:error.code??'probe-failed',reason:error.details?.reason??null,message:error.message.slice(0,240),stack:error.stack?.slice(0,4000)}})
 })
 ctx.effect(()=>async()=>{lifetime.abort();await task})
}
