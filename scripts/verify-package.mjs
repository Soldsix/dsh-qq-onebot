/** Publication checks for this independently installed transport bundle. */
import assert from 'node:assert/strict'
import {readFile,readdir} from 'node:fs/promises'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'

/** Validate the package kind and portable dependency declarations. */
export function verifyManifest(manifest){
 assert.equal(manifest.type,'module')
 assert.equal(manifest.license,'MIT')
 assert.ok(!manifest.bin,'Transport bundles do not add application binaries')
 assert.equal(manifest.dsh?.bundle?.patch,'./cordis.patch.yml')
 assert.equal(manifest.engines?.dsh,'0.2.2-rc.1')
 assert.equal(manifest.peerDependencies?.['@deepseek-ai/cordis'],'~4.1.0')
 assert.equal(manifest.peerDependencies?.['@deepseek-ai/dsh-credentials'],'0.2.2-rc.1')
 assert.equal(manifest.peerDependencies?.['dsh-im-kit'],'0.2.0')
 assert.equal(manifest.exports?.['.']?.import,'./dist/index.js')
 assert.equal(manifest.exports?.['.']?.types,'./dist/index.d.ts')
 for(const section of ['dependencies','peerDependencies','devDependencies'])for(const [name,value]of Object.entries(manifest[section]??{}))assert.ok(!/^(?:file:|link:|workspace:|[a-z]:[\\/]|[\\/])/i.test(value),'Nonportable dependency '+name)
}

/** Check paired bundle documentation without claiming unfinished UI works. */
export function verifyPair(english,chinese){
 for(const text of [english,chinese]){
  assert.match(text,/^kind: "package-bundle"$/m)
  assert.match(text,/^description: ".+"$/m)
  assert.equal(text.endsWith('\n')&&!text.endsWith('\n\n'),true)
 }
 assert.equal(english.split('\n').length,chinese.split('\n').length)
 assert.ok(english.split('## Summary\n')[1].split('\n## ')[0].trim().split(/\s+/).length<=100)
 const anchors=text=>[...text.matchAll(/<a id="([^"]+)">/g)].map(m=>m[1])
 assert.deepEqual(anchors(english),anchors(chinese))
}

/** Reject files not deliberately permitted in the public artifact. */
export function verifyFiles(paths){
 const exact=['LICENSE','README.md','README.zh.md','README.i18n.yaml','package.json','cordis.patch.yml']
 for(const path of paths)assert.ok(exact.includes(path)||/^dist\/[a-z][a-z-]*\.(?:js|d\.ts)$/.test(path),'Unexpected published file '+path)
 for(const required of [...exact,'dist/index.js','dist/index.d.ts'])assert.ok(paths.includes(required),'Missing public file '+required)
}

async function main(){
 const root=fileURLToPath(new URL('../',import.meta.url))
 const manifest=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'))
 verifyManifest(manifest)
 verifyPair(await readFile(new URL('../README.md',import.meta.url),'utf8'),await readFile(new URL('../README.zh.md',import.meta.url),'utf8'))
 const patch=await readFile(new URL('../cordis.patch.yml',import.meta.url),'utf8')
 assert.match(patch,/enabled: false/)
 for(const entry of await readdir(new URL('../src/',import.meta.url),{withFileTypes:true})){
  if(!entry.isFile()||!entry.name.endsWith('.ts'))continue
  const text=await readFile(new URL('../src/'+entry.name,import.meta.url),'utf8')
  assert.ok(text.startsWith('/**'),'Module documentation: '+entry.name)
  assert.ok(!/\bas unknown\b/.test(text),'Unknown assertion: '+entry.name)
  assert.equal(text.endsWith('\n')&&!text.endsWith('\n\n'),true,'Trailing newline: '+entry.name)
 }
 assert.ok(process.env.npm_execpath,'Run via npm run check')
 const child=spawn(process.execPath,[process.env.npm_execpath,'pack','--dry-run','--json','--ignore-scripts'],{cwd:root,signal:AbortSignal.timeout(60000),windowsHide:true,stdio:['ignore','pipe','pipe']})
 let stdout='',stderr='',failure
 child.stdout.on('data',data=>{stdout+=data});child.stderr.on('data',data=>{stderr+=data});child.once('error',error=>{failure=error})
 const code=await new Promise(resolve=>child.once('close',resolve))
 if(failure)throw failure
 assert.equal(code,0,stderr)
 const pack=JSON.parse(stdout)
 assert.equal(pack.length,1);verifyFiles(pack[0].files.map(file=>file.path))
 console.log(JSON.stringify({package:manifest.name,checks:['manifest','paired-docs','disabled-bundle','source-hygiene','packed-file-allowlist'],passed:true}))
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main()
