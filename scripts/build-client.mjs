/** Build a native ModuleLoader client using the Web profile's shared platform modules. */
import { build } from 'esbuild'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = fileURLToPath(new URL('../', import.meta.url))
const externals = ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-store']
const result = await build({
  absWorkingDir: root, entryPoints: ['src/client/index.ts'], outfile: 'dist/client.js', bundle: true,
  tsconfig: 'tsconfig.client.json', jsx: 'automatic',
  format: 'cjs', platform: 'browser', target: 'es2022', write: false, metafile: true,
  minify: false, external: externals, treeShaking: true, legalComments: 'inline',
  plugins: [{
    name: 'owned-styles',
    setup(build) {
      build.onLoad({ filter: /[\\/]src[\\/]client[\\/]style\.css$/ }, async args => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' }))
    },
  }],
})
for (const input of Object.keys(result.metafile.inputs)) {
  const path = relative(root, resolve(root, input))
  assert.ok(!path.startsWith('..') && !isAbsolute(path), `Build borrowed an undeclared ancestor dependency: ${input}`)
}
const javascript = result.outputFiles.find(file => file.path.endsWith('.js'))
assert.ok(javascript)
await mkdir(resolve(root,'.test-artifacts'),{recursive:true})
await writeFile(resolve(root,'.test-artifacts/client-build-meta.json'),JSON.stringify(result.metafile,null,2)+'\n')
for (const output of Object.values(result.metafile.outputs)) for (const dependency of output.imports) {
  assert.ok(!dependency.external || externals.includes(dependency.path), `Unexpected browser dependency: ${dependency.path}`)
}
assert.ok(!result.outputFiles.some(file => file.path.endsWith('.css')),'Client styles must be owned by a reversible effect')
const zodLicense = await readFile(resolve(root,'node_modules/zod/LICENSE'),'utf8')
const wrapped = `/*! Bundled zod/mini: MIT License\n${zodLicense.replaceAll('*/','* /').trim()}\n*/\nwindow.__ModuleLoader__.load({id:"dsh-qq-onebot",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${javascript.text}\nreturn module.exports;}});\n`
await writeFile(resolve(root, 'dist/client.js'), wrapped)
process.stdout.write(`${JSON.stringify({ clientBytes: Buffer.byteLength(wrapped), inputFiles: Object.keys(result.metafile.inputs).length, sharedPlatform:externals })}\n`)
