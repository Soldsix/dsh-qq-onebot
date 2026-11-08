import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {verifyManifest,verifyPair,verifyFiles} from '../scripts/verify-package.mjs'

test('publication checks reject wrong bundle kinds, private paths and incompatible peers',async()=>{
 const valid=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'))
 verifyManifest(valid)
 for(const modify of [p=>{delete p.dsh},p=>{delete p.dependencies['dsh-im-kit']},p=>{p.dependencies['dsh-im-kit']='^0.2.1'},p=>{p.bin='app.js'},p=>{p.dependencies.private='file:F:/private'},p=>{p.engines.dsh='*'},p=>{p.peerDependencies['@deepseek-ai/cordis']='~4.0.0'},p=>{p.exports['.'].types='./src/index.ts'}]){
  const copy=structuredClone(valid);modify(copy);assert.throws(()=>verifyManifest(copy))
 }
})

test('publication checks reject unpaired docs and accidental private artifact files',async()=>{
 const en=await readFile(new URL('../README.md',import.meta.url),'utf8'),zh=await readFile(new URL('../README.zh.md',import.meta.url),'utf8')
 verifyPair(en,zh)
 assert.throws(()=>verifyPair(en,zh+'extra\n'))
 assert.throws(()=>verifyPair(en.replace('package-bundle','package-library'),zh))
 const paths=['LICENSE','README.md','README.zh.md','README.i18n.yaml','package.json','cordis.patch.yml','dist/index.js','dist/index.d.ts','dist/control.js','dist/client.js','dist/client/index.d.ts']
 verifyFiles(paths)
 assert.throws(()=>verifyFiles([...paths,'.env']))
 assert.throws(()=>verifyFiles([...paths,'data/private.sqlite']))
 assert.throws(()=>verifyFiles(paths.filter(p=>p!=='dist/index.d.ts')))
})
