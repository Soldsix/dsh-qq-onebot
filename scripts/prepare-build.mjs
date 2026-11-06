/** Remove only this package's verified build directory before emitting either face. */
import { realpath, rm } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
const root=await realpath(fileURLToPath(new URL('../',import.meta.url)))
const output=resolve(root,'dist')
try {
  const target=await realpath(output)
  assert.equal(relative(root,target),'dist','Build output must not redirect outside this package')
} catch(error) { if(error.code!=='ENOENT')throw error }
await rm(output,{recursive:true,force:true})
