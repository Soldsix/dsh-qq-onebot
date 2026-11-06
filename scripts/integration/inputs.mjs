/** Require explicit local release inputs; integration tests never inspect production profiles. */
import {realpath,readFile,writeFile,mkdir,copyFile} from 'node:fs/promises'
import {resolve,join,basename} from 'node:path'
import {createHash} from 'node:crypto'
/** Return the deliberately provided im-kit archive and reject a missing fixture. */
export async function imKitArchive(){
 const index=process.argv.indexOf('--im-kit-archive')
 const input=index<0?process.env.DSH_IM_KIT_ARCHIVE:process.argv[index+1]
 if(!input)throw Error('Pass --im-kit-archive PATH (or DSH_IM_KIT_ARCHIVE) to the independent dsh-im-kit 0.2.0 release archive')
 const path=await realpath(resolve(input))
 if(!path.endsWith('.tgz'))throw Error('The im-kit integration input must be a release .tgz archive')
 return path
}
/** Copy release inputs into the run and record hashes before profile installation. */
export async function stageInputs(area,paths){
 const directory=join(area,'archives');await mkdir(directory,{recursive:true})
 if(new Set(paths.map(path=>basename(path))).size!==paths.length)throw Error('Integration archives must have distinct filenames')
 const records=[]
 for(const input of paths){
  const target=join(directory,basename(input));await copyFile(input,target)
  const data=await readFile(target)
  records.push({name:basename(target),sha256:createHash('sha256').update(data).digest('hex'),bytes:data.byteLength})
 }
 await writeFile(join(area,'inputs.json'),JSON.stringify(records,null,2)+'\n')
 return paths.map(path=>join(directory,basename(path)))
}
