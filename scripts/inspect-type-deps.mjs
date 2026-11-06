/** Identify declarations accidentally borrowed from ancestor installations. */
import ts from 'typescript'
import {fileURLToPath} from 'node:url'
import {relative,resolve,dirname} from 'node:path'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
const root=fileURLToPath(new URL('../',import.meta.url))
const input=ts.readConfigFile(resolve(root,'tsconfig.client.json'),ts.sys.readFile)
const config=ts.parseJsonConfigFileContent(input.config,ts.sys,root)
const program=ts.createProgram(config.fileNames,config.options)
const borrowed=new Set()
for(const file of program.getSourceFiles()){
 const rel=relative(root,file.fileName)
 if(!rel.startsWith('..'))continue
 const match=file.fileName.replaceAll('\\','/').match(/\/node_modules\/((?:@[^/]+\/)?[^/]+)\//)
 if(match)borrowed.add(match[1])
}
const report={borrowedPackages:[...borrowed].sort(),files:program.getSourceFiles().length}
await mkdir(resolve(root,'.test-artifacts'),{recursive:true})
await writeFile(resolve(root,'.test-artifacts/type-deps.json'),JSON.stringify(report,null,2)+'\n')
process.stdout.write(JSON.stringify(report)+'\n')
