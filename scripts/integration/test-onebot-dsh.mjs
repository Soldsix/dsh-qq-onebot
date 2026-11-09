/** Install local archives and exercise them through the supported DSH SDK profile. */
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {watch} from 'node:fs'
import {mkdtemp,mkdir,readFile,writeFile,realpath} from 'node:fs/promises'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {join,dirname,relative,sep,delimiter} from 'node:path'
import {createRequire} from 'node:module'
import {prepareQaProfile} from './qa-profile-dependencies.mjs'
import {imKitArchive,stageInputs} from './inputs.mjs'
import {pnpmScript} from './pnpm.mjs'

const workspace=fileURLToPath(new URL('../../',import.meta.url))
const hostRoot=workspace
const hostRequire=createRequire(join(hostRoot,'package.json'))
const {WebSocketServer}=hostRequire('ws')
const yaml=hostRequire('yaml')
const dsh=join(hostRoot,'node_modules','@deepseek-ai','dsh','lib','bin.js')
const controlTest=process.argv.includes('--control')
const packageVersion=JSON.parse(await readFile(join(workspace,'package.json'),'utf8')).version
const sources=[await imKitArchive(),join(workspace,'artifacts','dsh-qq-onebot-'+packageVersion+'.tgz')]
const artifacts=join(workspace,'.test-artifacts',controlTest?'native-control':'native-transport')
await mkdir(artifacts,{recursive:true})
const area=await mkdtemp(join(artifacts,'dsh-install-'))
const archives=await stageInputs(area,sources)
const home=join(area,'home'),profile='transport-qa',profileRoot=join(home,'profiles',profile)
await mkdir(join(area,'temp'),{recursive:true})
const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!/KEY|SECRET|TOKEN|PASSWORD/i.test(key)&&key.toUpperCase()!=='PATH')),PATH:join(workspace,'node_modules','.bin')+delimiter+(process.env.PATH??process.env.Path??''),TEMP:join(area,'temp'),TMP:join(area,'temp'),TMPDIR:join(area,'temp'),NPM_CONFIG_CACHE:join(workspace,'.npm-cache'),DSH_PRIMARY_RUNTIME:'',DSH_HOME:home,DEEPSEEK_API_KEY:'isolated-no-model-call',ONEBOT_ACCESS_TOKEN:'isolated-onebot-token',DSH_SYSTEM_PROMPT:'Isolated test with no model calls.'}
const records=[]
async function run(command,args,cwd){
 const lifetime=new AbortController(),deadline=AbortSignal.timeout(120000)
 const signal=AbortSignal.any([lifetime.signal,deadline])
 const child=spawn(command,args,{cwd,env,signal,windowsHide:true,stdio:['ignore','pipe','pipe']})
 let stdout='',stderr='',failure
 child.stdout.on('data',data=>{stdout+=data});child.stderr.on('data',data=>{stderr+=data})
 child.once('error',error=>{failure=error})
 const [code]=await new Promise(resolve=>child.once('close',(...values)=>resolve(values)))
 if(failure)throw failure
 assert.equal(signal.aborted,false,'Build/install process was cancelled')
 records.push({command:command===process.execPath?'node':command,args,code,stdout,stderr})
 assert.equal(code,0,stdout+'\n'+stderr)
 return stdout
}
const composition=await run(process.execPath,[dsh,'--profile',profile,'--from-default-profile','sdk','--dump-config'],area)
await prepareQaProfile(workspace,hostRoot,profileRoot,archives[0])
await writeFile(join(profileRoot,'.npmrc'),'package-import-method=hardlink\nstore-dir='+join(workspace,'.test-artifacts','pnpm-store').replaceAll('\\','/')+'\ncache-dir='+join(workspace,'.test-artifacts','pnpm-cache').replaceAll('\\','/')+'\n')
const pnpm=await pnpmScript(workspace)
await run(process.execPath,[pnpm,'add','@deepseek-ai/cordis@4.1.0','@deepseek-ai/schemastery@3.19.0','@deepseek-ai/dsh-credentials@0.2.2-rc.1','@deepseek-ai/dsh-config-editor@0.2.2-rc.1','@deepseek-ai/dsh-typert-protocol@0.2.2-rc.1','--ignore-scripts'],profileRoot)
await run(process.execPath,[dsh,'plugin','--profile',profile,'add',archives[1],'--ignore-scripts'],area)
const resolveInstalled=createRequire(join(profileRoot,'package.json'))
const pluginManifest=resolveInstalled.resolve('dsh-qq-onebot/package.json')
const pluginRequire=createRequire(pluginManifest)
const dependencies=[]
for(const name of ['dsh-im-kit','@deepseek-ai/cordis','@deepseek-ai/schemastery','@deepseek-ai/dsh-credentials','@deepseek-ai/dsh-config-editor','@deepseek-ai/dsh-typert-protocol','ws']){
 const path=await realpath(pluginRequire.resolve(name+'/package.json'))
 const location=relative(profileRoot,path)
 assert.ok(!location.startsWith('..'+sep)&&!location.includes('..'+sep),'Dependency escaped isolated plugin workspace: '+name)
 dependencies.push({name,version:JSON.parse(await readFile(path,'utf8')).version,path:location})
}
const server=new WebSocketServer({host:'127.0.0.1',port:0})
await once(server,'listening')
const requests=[],peers=[]
server.on('connection',(peer,request)=>{
 assert.equal(request.headers.authorization,'Bearer isolated-onebot-token')
 peers.push(peer)
 peer.on('message',raw=>{
  const frame=JSON.parse(raw.toString());requests.push(frame)
  const content=frame.params?.id==='native-root'?[{type:'text',data:{text:'NATIVE_FORWARD_ORIGINAL'}},{type:'reply',data:{id:'-44'}},{type:'image',data:{url:'https://example.invalid/original.gif'}},{type:'forward',data:{id:'native-child'}}]:[{type:'text',data:{text:'NATIVE_NESTED_ORIGINAL'}}]
  const data=frame.action==='get_forward_msg'?{messages:[{sender:{user_id:90000001,nickname:'claimed only'},group_id:99999999,content}]}:frame.action==='get_login_info'?{user_id:90000001}:frame.action==='get_status'?{online:true,good:true}:frame.action==='get_group_member_info'?{user_id:90000001,role:'member',shut_up_timestamp:0}:{message_id:501}
  peer.send(JSON.stringify({status:'ok',retcode:0,data,echo:frame.echo}))
 })
})
const readyPath=join(area,'ready.json'),resultPath=join(area,'result.json')
const required=controlTest?['@deepseek-ai/dsh-config-editor','@deepseek-ai/dsh-typert-registry','@deepseek-ai/dsh-api-remote-access','@deepseek-ai/dsh-api-gateway']:[]
const setup=required.filter(name=>!composition.includes(name)).map((name,index)=>({id:'onebot-qa-service-'+index,name}))
const overlay=[
 {id:'qq-onebot-transport',config:{enabled:!controlTest,tenantId:'qa-tenant',accountId:'90000001',allowedGroups:['90000100'],forwardUrl:'ws://127.0.0.1:'+server.address().port}},
 {insert:[...setup,{id:'onebot-host-probe',name:pathToFileURL(fileURLToPath(new URL(controlTest?'./onebot-control-host-probe.mjs':'./onebot-host-probe.mjs',import.meta.url))).href,config:{readyPath,resultPath,occupiedPort:server.address().port}}]},
]
await writeFile(join(profileRoot,'cordis.patch.yml'),yaml.stringify(overlay).replace('tenantId: qa-tenant',`tenantId: !!js '"qa-tenant"'`))
const abort=new AbortController(),deadline=AbortSignal.timeout(60000),lifetime=AbortSignal.any([abort.signal,deadline])
const child=spawn(process.execPath,[dsh,'--profile',profile],{cwd:area,env,windowsHide:true,stdio:['pipe','pipe','pipe']})
let stdout='',stderr='',exitCode
child.stdout.on('data',data=>{stdout+=data});child.stderr.on('data',data=>{stderr+=data})
const exit=once(child,'close').then(([code,signal])=>{exitCode=code;return{code,signal}})
async function waitFile(path){
 if(lifetime.aborted)throw lifetime.reason
 try{return JSON.parse(await readFile(path,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
 return new Promise((resolve,reject)=>{
  const close=()=>{watcher.close();lifetime.removeEventListener('abort',cancel)}
  const cancel=()=>{close();reject(lifetime.reason)}
  const watcher=watch(dirname(path),async(_type,name)=>{
   if(name!==path.split(sep).at(-1))return
   try{const body=JSON.parse(await readFile(path,'utf8'));close();resolve(body)}catch(error){if(error.code!=='ENOENT'){close();reject(error)}}
  })
  lifetime.addEventListener('abort',cancel,{once:true})
  void readFile(path,'utf8').then(body=>{close();resolve(JSON.parse(body))},error=>{if(error.code!=='ENOENT'){close();reject(error)}})
  void exit.then(()=>{close();reject(new Error('DSH exited before probe: '+stderr.slice(-2000)))})
 })
}
let result
try{
 const ready=await waitFile(readyPath)
 if(!controlTest){
  assert.equal(ready.verified,true)
  peers[0].send(JSON.stringify({post_type:'message',message_type:'group',time:1000,self_id:90000001,user_id:90000002,group_id:90000100,message_id:500,message:[{type:'at',data:{qq:'90000001'}},{type:'text',data:{text:'isolated test'}},{type:'forward',data:{id:'native-root'}}]}))
 }
 result=await waitFile(resultPath)
 if(controlTest){assert.equal(result.passed,true);assert.equal(requests.filter(r=>r.action.startsWith('send_')).length,0)}
 else{assert.equal(result.received,true);assert.equal(result.directedToBot,true);assert.deepEqual(result.receipt,{status:'accepted',messageIds:['501']});assert.equal(requests.filter(r=>r.action==='send_group_msg').length,1);assert.equal(requests.filter(r=>r.action==='get_forward_msg').length,2);assert.equal(result.forwardReads,true);assert.equal(result.forwardScopes,true);assert.equal(result.forwardMedia,true);assert.deepEqual(result.mergedReceipt,{status:'accepted',messageIds:['501']});assert.equal(result.forwardDispatch,true);assert.equal(result.normalizedSnapshot,true);const writes=requests.filter(r=>r.action==='send_group_forward_msg');assert.equal(writes.length,1);assert.equal(writes[0].params.messages[0].data.content[0].data.text,'NATIVE_MERGED_ORIGINAL');assert.deepEqual(Buffer.from(writes[0].params.messages[0].data.content[1].data.file.slice('base64://'.length),'base64'),Buffer.from([0,1,2,253,254,255]))}
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'shutdown',params:{}})+'\n')
 const stopped=await Promise.race([exit,new Promise((_,reject)=>lifetime.addEventListener('abort',()=>reject(lifetime.reason),{once:true}))])
 assert.deepEqual(stopped,{code:0,signal:null})
 assert.ok(stdout.split('\n').some(line=>{try{const frame=JSON.parse(line);return frame.id===1&&!frame.error}catch(error){return false}}),'SDK shutdown response missing')
}finally{
 if(exitCode===undefined){child.stdin.end();const fallback=setTimeout(()=>child.kill(),5000);await exit;clearTimeout(fallback)}
 abort.abort();for(const peer of server.clients)peer.terminate();await new Promise(resolve=>server.close(resolve))
 await writeFile(join(area,'process.json'),JSON.stringify({stdout,stderr,exitCode,requests:requests.map(r=>r.action)},null,2)+'\n')
 await writeFile(join(area,'installation.json'),JSON.stringify(records,null,2)+'\n')
}
await writeFile(join(area,'summary.json'),JSON.stringify({profile,dependencies,...result,exitCode,automaticPatrolEnabled:false,productionTouched:false},null,2)+'\n')
console.log(JSON.stringify({area,installed:true,controlTest,accountVerified:true,normalShutdown:true,...result,modelRequests:0,qqMessagesSent:0}))
