/** Install exact archives in a new consumer, without application launch or ancestor runtime dependencies. */
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdir,mkdtemp,readFile,writeFile,realpath,copyFile,statfs} from 'node:fs/promises'
import {join,resolve,relative,isAbsolute,basename} from 'node:path'
import {fileURLToPath} from 'node:url'
import ts from 'typescript'
import {verifyInstalledArchive} from './verify-installed.mjs'
import {imKitInput} from '../release-spec.mjs'
const root=fileURLToPath(new URL('../../',import.meta.url)),args=process.argv
const argument=(key,otherwise)=>{const index=args.indexOf(key);assert.ok(index<0?otherwise:args[index+1],'Pass '+key);return index<0?otherwise:args[index+1]}
assert.ok(process.env.npm_execpath,'Run through npm run test:consumer')
const manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8')),disk=await statfs(root);assert.ok(disk.bavail*disk.bsize>=1073741824,'Consumer installation requires a one-GiB free-space budget')
const runs=join(root,'.test-artifacts','consumer');await mkdir(runs,{recursive:true});const area=await mkdtemp(join(runs,'run-')),attempt=await mkdtemp(join(area,'attempt-')),archives=[]
for(const source of[await realpath(argument('--im-kit-archive')),await realpath(argument('--onebot-archive',join(root,'artifacts',manifest.name+'-'+manifest.version+'.tgz')))]){const path=join(attempt,basename(source));await copyFile(source,path);archives.push(path)}
assert.equal(createHash('sha256').update(await readFile(archives[0])).digest('hex'),imKitInput.sha256)
await writeFile(join(area,'package.json'),JSON.stringify({name:'isolated-onebot-consumer',private:true,type:'module',overrides:manifest.overrides},null,2)+'\n');await mkdir(join(attempt,'temp'))
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/KEY|SECRET|TOKEN|PASSWORD/i.test(key)));Object.assign(env,{NPM_CONFIG_CACHE:join(root,'.npm-cache'),TEMP:join(attempt,'temp'),TMP:join(attempt,'temp')})
const commands=[]
async function run(argv){const timeout=AbortSignal.timeout(300000),child=spawn(process.execPath,argv,{cwd:area,env,windowsHide:true,signal:timeout,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',failure;child.stdout.on('data',data=>{stdout+=data});child.stderr.on('data',data=>{stderr+=data});child.once('error',error=>{failure=error});const done=new Promise(resolve=>child.once('close',(...values)=>resolve(values)));try{await writeFile(join(attempt,'setup-live.json'),JSON.stringify({pid:child.pid})+'\n')}catch(error){child.kill('SIGKILL');await done;throw error}const [code,signal]=await done;commands.push({argv,code,signal,timedOut:timeout.aborted,stdout,stderr});await writeFile(join(attempt,'commands.json'),JSON.stringify(commands,null,2)+'\n');if(failure)throw failure;assert.equal(timeout.aborted,false);assert.equal(signal,null);assert.equal(code,0,(stderr+'\n'+stdout).slice(-1800));return stdout}
await run([process.env.npm_execpath,'install','--ignore-scripts','--no-audit','--no-fund','--package-lock=false',...archives,...Object.entries(manifest.peerDependencies).map(([name,version])=>name+'@'+version),'@deepseek-ai/dsh@0.2.2-rc.1','@types/node@24.0.0','@types/react@18.3.28','@types/react-dom@18.3.7'])
const installedFiles=await verifyInstalledArchive(archives[1],join(area,'node_modules',manifest.name),join(attempt,'installed-files.json')),consumer=join(attempt,'consumer.ts')
await writeFile(consumer,`import z from '@deepseek-ai/schemastery'
import type {Context} from '@deepseek-ai/cordis'
import {Config,OneBotTransport,type OneBotForwardResult} from 'dsh-qq-onebot'
import type {ConversationScope,MessageId,ForwardId} from 'dsh-im-kit'
import type * as Client from 'dsh-qq-onebot/client'
const config=z.resolve({enabled:false},Config,{})[0]
const limit:number=config.maxForwardNodes+config.maxForwardResources+config.maxForwardDepth+config.maxForwardCalls
async function read(ctx:Context,scope:ConversationScope,root:MessageId,resource:ForwardId,signal:AbortSignal):Promise<OneBotForwardResult>{return ctx.qqOnebot.readForward(scope,root,resource,signal)}
void limit;void read;void OneBotTransport
export type NativeClient=typeof Client
`)
const program=ts.createProgram([consumer],{strict:true,noEmit:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,types:['node','react'],typeRoots:[join(area,'node_modules','@types')],lib:['lib.es2023.d.ts','lib.esnext.disposable.d.ts','lib.dom.d.ts'],skipLibCheck:false,allowImportingTsExtensions:true,jsx:ts.JsxEmit.ReactJSX}),diagnostics=ts.getPreEmitDiagnostics(program)
await writeFile(join(attempt,'type-diagnostics.txt'),ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCurrentDirectory:()=>area,getCanonicalFileName:file=>file,getNewLine:()=> '\n'}));assert.equal(diagnostics.length,0,'Consumer declaration errors; see owned diagnostics')
const compiler=await realpath(join(root,'node_modules','typescript','lib')),inputs=program.getSourceFiles().map(file=>resolve(file.fileName));for(const path of inputs){const local=relative(area,path),library=relative(compiler,path);assert.ok(!local.startsWith('..')&&!isAbsolute(local)||!library.startsWith('..')&&!isAbsolute(library),'Consumer borrowed an ancestor declaration')}
await writeFile(join(attempt,'runtime.mjs'),`import assert from 'node:assert/strict'
import {Config,OneBotTransport,resolveConfig,name} from 'dsh-qq-onebot'
assert.equal(name,'qq-onebot');assert.equal(Config({}).enabled,false);assert.equal(resolveConfig(Config({}),{}),null);assert.equal(typeof OneBotTransport.prototype.readForward,'function')
console.log(JSON.stringify({passed:true,applicationsStarted:0,connectionsOpened:0}))
`)
const runtime=JSON.parse((await run([join(attempt,'runtime.mjs')])).trim()),result={passed:true,archiveSha256:createHash('sha256').update(await readFile(archives[1])).digest('hex'),installedFiles,declarationInputs:inputs.length,ancestorDependenciesBorrowed:false,strictDeclarationErrors:0,runtime,realModelCalls:0,qqMessages:0,bilibiliWrites:0}
await writeFile(join(attempt,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({area,attempt,...result}))
