/** Apply dependency fixes only to a freshly generated, isolated QA profile. */
import {readFile,writeFile,realpath} from 'node:fs/promises'
import {join,relative,isAbsolute} from 'node:path'
import {createHash} from 'node:crypto'
import {imKitInput} from '../release-spec.mjs'
/** Set the isolated profile's pnpm overrides to the tested QA Host versions. */
export async function prepareQaProfile(workspace,hostRoot,profileRoot,libraryArchive){
 const root=await realpath(workspace),target=await realpath(profileRoot),path=relative(root,target)
 if(path.startsWith('..')||isAbsolute(path))throw Error('QA profile escaped the isolated workspace')
 const host=JSON.parse(await readFile(join(hostRoot,'package.json'),'utf8'))
 const library=await realpath(libraryArchive),libraryLocation=relative(root,library)
 if(libraryLocation.startsWith('..')||isAbsolute(libraryLocation)||createHash('sha256').update(await readFile(library)).digest('hex')!==imKitInput.sha256)throw Error('Unverified isolated library input')
 const manifestPath=join(profileRoot,'package.json'),manifest=JSON.parse(await readFile(manifestPath,'utf8'))
 manifest.pnpm={...manifest.pnpm,overrides:{...manifest.pnpm?.overrides,...host.overrides,'dsh-im-kit':'file:'+library.replaceAll('\\','/')}}
 await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n')
}
