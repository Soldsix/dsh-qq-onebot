/** Run the published native page in an isolated DSH Web profile and a fresh headless browser. */
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {createServer} from 'node:http'
import {mkdtemp,mkdir,readFile,writeFile,realpath} from 'node:fs/promises'
import {join,relative,delimiter} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createRequire} from 'node:module'
import {prepareQaProfile} from './qa-profile-dependencies.mjs'
import {imKitArchive,stageInputs} from './inputs.mjs'

const workspace=fileURLToPath(new URL('../../',import.meta.url)),hostRoot=workspace
const hostRequire=createRequire(join(hostRoot,'package.json')),yaml=hostRequire('yaml'),{WebSocketServer}=hostRequire('ws')
process.env.PLAYWRIGHT_BROWSERS_PATH??=join(workspace,'.test-artifacts','browsers')
const {chromium}=hostRequire('playwright')
const librarySource=await imKitArchive()
const version=JSON.parse(await readFile(join(workspace,'package.json'),'utf8')).version
const artifacts=join(workspace,'.test-artifacts','native-web')
await mkdir(artifacts,{recursive:true})
const area=await mkdtemp(join(artifacts,'web-install-')),home=join(area,'home'),profile='onebot-web-qa',profileRoot=join(home,'profiles',profile)
const [libraryArchive,pluginArchive]=await stageInputs(area,[librarySource,join(workspace,'artifacts','dsh-qq-onebot-'+version+'.tgz')])
const dsh=join(hostRoot,'node_modules','@deepseek-ai','dsh','lib','bin.js')
let modelRequests=0,modelCatalogReads=0
const modelHttp=createServer((request,response)=>{
 response.setHeader('Content-Type','application/json')
 if(request.method==='GET'&&request.url?.endsWith('/models')){modelCatalogReads++;response.end(JSON.stringify({object:'list',data:['deepseek-v4.1-flash','deepseek-chat','deepseek-reasoner'].map(id=>({id,object:'model',owned_by:'fixture'}))}));return}
 modelRequests++;response.statusCode=500;response.end(JSON.stringify({error:'No model execution is permitted in this UI test'}))
})
modelHttp.listen(0,'127.0.0.1');await once(modelHttp,'listening');modelHttp.unref()
const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!/KEY|SECRET|TOKEN|PASSWORD/i.test(key))),DSH_HOME:home,DSH_SYSTEM_PROMPT:'Isolated UI fixture. No model requests.',DEEPSEEK_API_KEY:'isolated-no-model-call',DEEPSEEK_BASE_URL:'http://127.0.0.1:'+modelHttp.address().port+'/v1',ONEBOT_ACCESS_TOKEN:'isolated-onebot-token'}
const records=[]
async function run(command,args,cwd){
 const child=spawn(command,args,{cwd,env,signal:AbortSignal.timeout(120000),windowsHide:true,stdio:['ignore','pipe','pipe']})
 let stdout='',stderr='',failure
 child.stdout.on('data',data=>{stdout+=data});child.stderr.on('data',data=>{stderr+=data});child.once('error',error=>{failure=error})
 const [code]=await once(child,'close')
 records.push({args,code,stdout,stderr});if(failure)throw failure
 assert.equal(code,0,stderr+'\n'+stdout)
 return stdout
}
await run(process.execPath,[dsh,'--profile',profile,'--from-default-profile','web','--dump-config'],area)
await prepareQaProfile(workspace,hostRoot,profileRoot)
await writeFile(join(profileRoot,'.npmrc'),'package-import-method=copy\nstore-dir='+join(workspace,'.test-artifacts','pnpm-store').replaceAll('\\','/')+'\ncache-dir='+join(workspace,'.test-artifacts','pnpm-cache').replaceAll('\\','/')+'\n')
let pnpm
findPnpm: for(const dir of (process.env.PATH??'').split(delimiter))for(const candidate of [join(dir,'pnpm.cjs'),join(dir,'node_modules','pnpm','bin','pnpm.cjs'),join(dir,'node_modules','corepack','dist','pnpm.js')]){
 try{await realpath(candidate);pnpm=candidate;break findPnpm}catch(error){if(error.code!=='ENOENT')throw error}
}
assert.ok(pnpm,'A local pnpm installation is required')
await run(process.execPath,[pnpm,'add','@deepseek-ai/cordis@4.1.0','@deepseek-ai/schemastery@3.19.0','@deepseek-ai/dsh-credentials@0.2.2-rc.1','@deepseek-ai/dsh-config-editor@0.2.2-rc.1','@deepseek-ai/dsh-typert-protocol@0.2.2-rc.1','--ignore-scripts'],profileRoot)
await run(process.execPath,[dsh,'plugin','--profile',profile,'add',pluginArchive],area)
await writeFile(join(profileRoot,'cordis.patch.yml'),yaml.stringify([{id:'qq-onebot-control',config:{statusRefreshMs:250}}]))
const server=new WebSocketServer({host:'127.0.0.1',port:0})
await once(server,'listening')
let connections=0
const actions=[]
server.on('connection',(peer,request)=>{
 assert.equal(request.headers.authorization,'Bearer isolated-onebot-token');connections++
 peer.on('message',raw=>{
  const frame=JSON.parse(raw.toString());actions.push(frame.action)
  const data=frame.action==='get_login_info'?{user_id:90000001}:frame.action==='get_status'?{online:true,good:true}:{user_id:90000001,role:'member',shut_up_timestamp:0}
  peer.send(JSON.stringify({status:'ok',retcode:0,data,echo:frame.echo}))
 })
})
const child=spawn(process.execPath,[dsh,'--profile',profile,'--host','127.0.0.1','--port','0','--no-open'],{cwd:area,env,windowsHide:true,stdio:['pipe','pipe','pipe']})
let stdout='',stderr='',exitCode,context,page,origin
const errors=[],consoleErrors=[],checks=[]
const exit=once(child,'close').then(([code,signal])=>{exitCode=code;return{code,signal}})
const ready=new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>reject(Error('Isolated DSH Web did not become ready')),60000)
 const inspect=()=>{const match=(stdout+'\n'+stderr).match(/https?:\/\/127\.0\.0\.1:\d+[^\s\u001b]*/);if(match){clearTimeout(timer);resolve(match[0])}}
 child.stdout.on('data',data=>{stdout+=data;inspect()});child.stderr.on('data',data=>{stderr+=data;inspect()})
 void exit.then(()=>{clearTimeout(timer);reject(Error('Isolated Web exited before ready: '+stderr.slice(-1200)))})
})
try{
 const loginUrl=await ready
 origin=new URL(loginUrl).origin
 await mkdir(join(area,'temp'),{recursive:true})
 context=await chromium.launchPersistentContext(join(area,'browser-profile'),{headless:true,viewport:{width:1280,height:960},locale:'zh-CN',colorScheme:'light',downloadsPath:join(area,'downloads'),env:{...process.env,TEMP:join(area,'temp'),TMP:join(area,'temp')}})
 await context.route('**/*',route=>{const url=new URL(route.request().url());return url.origin===origin||['data:','blob:'].includes(url.protocol)?route.continue():route.abort()})
 await context.addInitScript(()=>{
  let loader
  Object.defineProperty(window,'__ModuleLoader__',{configurable:true,get:()=>loader,set:value=>{
   loader=value
   const create=value.create
   value.create=function(options){const modules=create.call(this,options);window.__onebotQaModules=modules;return modules}
  }})
 })
 page=context.pages()[0]??await context.newPage()
 page.on('pageerror',error=>errors.push(error.message))
 page.on('console',message=>{if(['error','warning'].includes(message.type()))consoleErrors.push(message.type()+': '+message.text().slice(0,2000))})
 await page.goto(loginUrl,{waitUntil:'domcontentloaded'})
 await page.getByRole('button',{name:/^继续$|^Continue$/}).click({timeout:20000})
 await page.getByRole('button',{name:/^插件$|^Plugins$/}).first().click({timeout:20000})
 await page.getByText('dsh-qq-onebot',{exact:true}).first().click({timeout:15000})
 const form=page.locator('.qqob-page')
 await form.getByText(/此插件本身不生成自动回复|does not generate automatic replies/).waitFor({timeout:15000})
 checks.push('native-plugin-page-loaded')
 await form.getByLabel(/预期机器人 QQ 号|Expected QQ account/).fill('90000001')
 await form.getByLabel(/正向 WebSocket 地址|Forward WebSocket URL/).fill('ws://127.0.0.1:'+server.address().port)
 await form.getByLabel(/允许的群号|Allowed group IDs/).fill('90000100')
 await form.getByRole('switch',{name:/启用传输|Enable transport/}).click()
 await form.getByRole('button',{name:/^保存并应用$|^Save and apply$/}).click()
 await form.getByText(/已保存配置正在运行|Saved configuration is applied/).waitFor({timeout:15000})
 await page.waitForFunction(()=>[...document.querySelectorAll('.qqob-status dl>div')].some(row=>/QQ 在线证据|QQ online evidence/.test(row.textContent??'')&&/是|Yes/.test(row.querySelector('dd')?.textContent??'')))
 assert.equal(connections,1)
 checks.push('native-ui-save-applied-and-verified')
 await form.getByLabel(/预期机器人 QQ 号|Expected QQ account/).fill('not-an-account')
 await form.getByRole('button',{name:/^保存并应用$|^Save and apply$/}).click()
 await form.locator('[aria-invalid="true"]').waitFor()
 assert.equal(await form.getByLabel(/预期机器人 QQ 号|Expected QQ account/).inputValue(),'not-an-account')
 assert.equal(connections,1)
 await form.getByRole('button',{name:/放弃修改|Discard changes/}).click()
 checks.push('invalid-ui-edit-keeps-draft-and-running-transport')
 await page.setViewportSize({width:1280,height:1800})
 await form.evaluate(element=>element.scrollIntoView({block:'start'}))
 await page.screenshot({path:join(area,'light.png'),fullPage:true})
 await form.getByLabel(/租户标识|Tenant ID/).fill('edited-without-saving')
 await form.getByRole('button',{name:/刷新状态|Refresh status/}).click()
 await form.getByText(/有未保存的修改|Unsaved changes/).waitFor()
 assert.equal(await form.getByLabel(/租户标识|Tenant ID/).inputValue(),'edited-without-saving')
 checks.push('status-refresh-retains-draft')
 await form.getByRole('button',{name:/放弃修改|Discard changes/}).click()
 assert.equal(await form.getByLabel(/租户标识|Tenant ID/).inputValue(),'qq')
 await page.emulateMedia({colorScheme:'dark'})
 await form.evaluate(element=>element.scrollIntoView({block:'start'}))
 await page.screenshot({path:join(area,'dark.png'),fullPage:true})
 await page.getByRole('button',{name:/^收起侧边栏$|^Collapse sidebar$/}).click()
 await page.setViewportSize({width:520,height:1600})
 await form.evaluate(element=>element.scrollIntoView({block:'start'}))
 assert.ok(await form.evaluate(element=>element.scrollWidth<=element.clientWidth+2),'Plugin form overflows the narrow viewport')
 assert.ok(await form.evaluate(element=>[...element.querySelectorAll('input,select')].filter(input=>input.getClientRects().length).every(input=>{const rect=input.getBoundingClientRect();return rect.left>=0&&rect.right<=window.innerWidth})),'A visible form field is outside the viewport')
 await page.screenshot({path:join(area,'narrow.png'),fullPage:true})
 checks.push('light-dark-and-narrow-layout')
 await page.setViewportSize({width:1280,height:960})
 await page.getByRole('button',{name:/^打开侧边栏$|^Open sidebar$/}).click()
 await page.reload({waitUntil:'domcontentloaded'})
 await page.getByRole('button',{name:/^插件$|^Plugins$/}).first().click({timeout:20000})
 await page.getByText('dsh-qq-onebot',{exact:true}).first().click({timeout:15000})
 await form.getByLabel(/预期机器人 QQ 号|Expected QQ account/).waitFor()
 assert.equal(await form.getByLabel(/预期机器人 QQ 号|Expected QQ account/).inputValue(),'90000001')
 checks.push('browser-reload-retains-saved-config')
 await form.getByRole('button',{name:/按已保存配置重连|Reconnect saved configuration/}).click()
 await page.getByText(/^已开始重新连接$|^Reconnection started$/).waitFor({timeout:15000})
 await page.waitForFunction(()=>[...document.querySelectorAll('.qqob-status dl>div')].some(row=>/QQ 在线证据|QQ online evidence/.test(row.textContent??'')&&/是|Yes/.test(row.querySelector('dd')?.textContent??'')))
 assert.equal(connections,2)
 await form.getByRole('switch',{name:/启用传输|Enable transport/}).click()
 await form.getByRole('button',{name:/^保存并应用$|^Save and apply$/}).click()
 await form.getByText(/通道未启用|Transport is disabled/).waitFor({timeout:15000})
 checks.push('ui-reconnect-and-disable-with-page-retained')
 assert.equal(actions.some(action=>action.startsWith('send_')),false)
 assert.deepEqual(errors,[])
 assert.deepEqual(consoleErrors,[])
 assert.equal(modelRequests,0)
 await writeFile(join(area,'result.json'),JSON.stringify({passed:true,checks,connections,clientErrors:errors,consoleErrors,modelRequests,modelCatalogReads,qqMessagesSent:0},null,2)+'\n')
 console.log(JSON.stringify({area,passed:true,checks,modelRequests,qqMessagesSent:0}))
}catch(error){
 if(page)await page.screenshot({path:join(area,'failure.png'),fullPage:true}).catch(()=>{})
 const boot=await page?.evaluate(()=>({ownEntries:window.__DSH_BOOT__?.entries?.filter(row=>row.id==='dsh-qq-onebot').map(row=>({id:row.id,inject:row.inject,external:row.external})),clientState:window.__onebotQaModules?.entries.state.getSnapshot(),ownExports:Object.keys(window.__onebotQaModules?.loadCache.get('dsh-qq-onebot')?.exports??{}),styleMounted:document.querySelectorAll('style[data-qq-onebot]').length,text:document.body.innerText.slice(-2000)})).catch(()=>null)
 await writeFile(join(area,'result.json'),JSON.stringify({passed:false,checks,error:{message:error.message,stack:error.stack},clientErrors:errors,consoleErrors,boot},null,2)+'\n')
 throw error
}finally{
 await context?.close()
 if(exitCode===undefined){child.kill('SIGINT');const fallback=setTimeout(()=>child.kill(),5000);await exit;clearTimeout(fallback)}
 for(const peer of server.clients)peer.terminate();await new Promise(resolve=>server.close(resolve))
 await new Promise(resolve=>modelHttp.close(resolve))
 const redact=text=>text.replace(/https?:\/\/127\.0\.0\.1:\d+[^\s\u001b]*/g,url=>new URL(url).origin+'/<auth-redacted>')
 await writeFile(join(area,'process.json'),JSON.stringify({stdout:redact(stdout),stderr:redact(stderr),exitCode,actions,connections},null,2)+'\n')
 await writeFile(join(area,'installation.json'),JSON.stringify(records,null,2)+'\n')
}
