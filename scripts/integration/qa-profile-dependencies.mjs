/** Apply dependency fixes only to a freshly generated, isolated QA profile. */
import {readFile,writeFile,realpath} from 'node:fs/promises'
import {join,relative,isAbsolute} from 'node:path'
/** Set the isolated profile's pnpm overrides to the tested QA Host versions. */
export async function prepareQaProfile(workspace,hostRoot,profileRoot){
 const root=await realpath(workspace),target=await realpath(profileRoot),path=relative(root,target)
 if(path.startsWith('..')||isAbsolute(path))throw Error('QA profile escaped the isolated workspace')
 const host=JSON.parse(await readFile(join(hostRoot,'package.json'),'utf8'))
 const manifestPath=join(profileRoot,'package.json'),manifest=JSON.parse(await readFile(manifestPath,'utf8'))
 manifest.pnpm={...manifest.pnpm,overrides:{...manifest.pnpm?.overrides,...host.overrides}}
 await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n')
}
