/** Isolated consumer roots reuse the explicitly verified shared archive for every dependency edge. */
import assert from 'node:assert/strict'
import {isAbsolute} from 'node:path'
/** @param overrides - package's declared QA updates. @param archive - absolute, already hash-verified public im-kit archive copied into this test run. @returns private consumer settings; the published package and its public dependency URL are unchanged. */
export function consumerManifest(overrides,archive){
 assert.ok(isAbsolute(archive)&&archive.endsWith('.tgz'),'Expected a verified absolute archive input')
 return{name:'isolated-onebot-consumer',private:true,type:'module',dependencies:{'dsh-im-kit':'file:'+archive.replaceAll('\\','/')},overrides:{...overrides,'dsh-im-kit':'$dsh-im-kit'}}
}
