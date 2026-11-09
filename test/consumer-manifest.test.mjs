/** Real npm resolution must reuse the exact archive instead of refetching an identical transitive URL. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {once} from 'node:events'
import {createServer} from 'node:http'
import {spawn} from 'node:child_process'
import {consumerManifest} from '../scripts/integration/consumer-manifest.mjs'
import {npmCli} from '../scripts/release-cache.mjs'

test('a verified explicit shared archive overrides every transitive URL; omitting it reproduces the failed fetch',{timeout:120000},async t=>{
 const base=fileURLToPath(new URL('../.test-artifacts/npm-resolution/',import.meta.url));await mkdir(base,{recursive:true});const area=await mkdtemp(join(base,'case-')),shared=join(area,'shared'),parent=join(area,'parent');await mkdir(shared);await mkdir(parent)
 let requests=0;const server=createServer((request,response)=>{requests++;response.writeHead(504);response.end('Synthetic transient asset failure')});server.listen(0,'127.0.0.1');t.after(()=>new Promise(resolve=>server.close(resolve)));await once(server,'listening')
 const endpoint='http://127.0.0.1:'+server.address().port+'/shared.tgz'
 await writeFile(join(shared,'package.json'),JSON.stringify({name:'dsh-im-kit',version:'0.0.0-synthetic',type:'module',main:'index.js'}));await writeFile(join(shared,'index.js'),'export const origin="exact verified fixture"\n')
 await writeFile(join(parent,'package.json'),JSON.stringify({name:'synthetic-dependent',version:'0.0.0',dependencies:{'dsh-im-kit':endpoint}}))
 const cli=await npmCli(),env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!/KEY|SECRET|TOKEN|PASSWORD/i.test(key))),NPM_CONFIG_CACHE:join(area,'cache'),TEMP:area,TMP:area,TMPDIR:area}
 async function run(cwd,args){const deadline=AbortSignal.timeout(45000),child=spawn(process.execPath,[cli,...args],{cwd,env,windowsHide:true,signal:deadline,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',failure;child.stdout.on('data',data=>{stdout+=data});child.stderr.on('data',data=>{stderr+=data});child.once('error',error=>{failure=error});const[code,signal]=await once(child,'close');if(failure)throw failure;assert.equal(deadline.aborted,false);assert.equal(signal,null);return{code,stdout,stderr}}
 for(const directory of[shared,parent]){const result=await run(directory,['pack','--ignore-scripts','--json']);assert.equal(result.code,0,result.stderr)}
 const archive=join(shared,'dsh-im-kit-0.0.0-synthetic.tgz'),parentArchive=join(parent,'synthetic-dependent-0.0.0.tgz'),positive=join(area,'positive'),negative=join(area,'negative');await mkdir(positive);await mkdir(negative)
 const admitted=consumerManifest({},archive);admitted.dependencies['synthetic-dependent']='file:'+parentArchive.replaceAll('\\','/');await writeFile(join(positive,'package.json'),JSON.stringify(admitted));const install=['install','--ignore-scripts','--no-audit','--no-fund','--package-lock=false','--fetch-retries=0']
 const success=await run(positive,install);assert.equal(success.code,0,success.stderr);assert.equal(requests,0);assert.equal(JSON.parse(await readFile(join(positive,'node_modules/dsh-im-kit/package.json'),'utf8')).version,'0.0.0-synthetic')
 const rejected=structuredClone(admitted);delete rejected.overrides['dsh-im-kit'];await writeFile(join(negative,'package.json'),JSON.stringify(rejected));const failure=await run(negative,install);assert.notEqual(failure.code,0);assert.match(failure.stderr,/504/);assert.ok(requests>=1)
 assert.throws(()=>consumerManifest({},'relative/private.tgz'));assert.throws(()=>consumerManifest({},archive.replace('.tgz','.json')))
})
