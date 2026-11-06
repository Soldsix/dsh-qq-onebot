import test from 'node:test'
import assert from 'node:assert/strict'
import {identifier,scopeKey} from 'dsh-im-kit'
import {parseSegments,parseMessage,wireId,unescapeCq,allowsScope} from '../dist/wire.js'
import {spec,message} from './helpers.mjs'

function parse(raw,settings=spec()){
 let n=0
 return parseMessage(raw,settings,2000000,()=>identifier('im.attachment','attachment-'+(++n)))
}
test('wire identifiers preserve signed message IDs and reject rounded numbers',()=>{
 assert.equal(wireId(-10),'-10');assert.equal(wireId('90000002'),'90000002')
 for(const value of [null,undefined,{},1.2,Number.MAX_SAFE_INTEGER+1,'01','1.5'])assert.equal(wireId(value),null)
})
test('CQ decoding respects text escaping, parameter commas and equal signs',()=>{
 assert.equal(unescapeCq('&amp;#91; &#91;x&#93; &#44;',false),'&#91; [x] &#44;')
 const segments=parseSegments('a&#91;b&#93;[CQ:share,title=a&#44;b=x,url=https://example.com/?x=1&amp;y=2]z',10)
 assert.deepEqual(segments.map(x=>x.type),['text','share','text'])
 assert.equal(segments[0].data.text,'a[b]')
 assert.equal(segments[1].data.title,'a,b=x')
 assert.equal(segments[1].data.url,'https://example.com/?x=1&y=2')
 assert.throws(()=>parseSegments('[CQ:at,qq=1,qq=2]',10),/duplicate/)
 assert.throws(()=>parseSegments('[CQ:at,bad]',10),/invalid-cq/)
 assert.throws(()=>parseSegments([{type:'text',data:{text:'a'}},{type:'text',data:{text:'b'}}],1),/limit/)
 assert.throws(()=>parseSegments(1,10),/invalid-message/)
 assert.throws(()=>parseSegments([{type:'text',data:null}],10),/invalid-segment/)
})
test('only actual protocol mentions direct a group message to the bound bot',()=>{
 assert.equal(parse(message()).message.directedToBot,false)
 assert.equal(parse(message({message:[{type:'at',data:{qq:'90000001'}}]})).message.directedToBot,true)
 assert.equal(parse(message({message:'&#91;CQ:at,qq=90000001&#93;'})).message.directedToBot,false)
 assert.equal(parse(message({message:[{type:'at',data:{qq:'all'}}]})).message.directedToBot,false)
 assert.equal(parse(message({message:[{type:'at',data:{qq:'90000003'}}]})).message.directedToBot,false)
})
test('group and private messages remain distinct and honor operator allowlists',()=>{
 const group=parse(message()),dm=parse(message({message_type:'private',group_id:undefined}))
 assert.notEqual(scopeKey(group.message.scope),scopeKey(dm.message.scope))
 assert.equal(dm.message.directedToBot,true)
 assert.equal(parse(message({group_id:90000101})),null)
 assert.equal(parse(message({message_type:'private'}),spec({allowPrivate:false})),null)
 assert.equal(parse(message({message_type:'private'}),spec({privateUsers:['90000003']})),null)
 assert.equal(parse(message({user_id:90000001})),null)
 assert.equal(allowsScope({...group.message.scope,account:{...group.message.scope.account,tenantId:identifier('im.tenant','other')}},spec()),false)
 assert.throws(()=>parse(message({self_id:90000003})),/account-mismatch/)
})
test('original image, mface, animation and audio source references are preserved',()=>{
 const result=parse(message({message:[
  {type:'image',data:{url:'https://example.com/original.png',file:'original-key',sub_type:1}},
  {type:'image',data:{url:'https://example.com/animation.gif',sub_type:'1'}},
  {type:'mface',data:{url:'https://example.com/mface.webp'}},
  {type:'record',data:{file:'voice.silk'}},
  {type:'video',data:{url:'https://example.com/video.mp4'}},
  {type:'file',data:{name:'source.html',file:'file-key'}},
  {type:'reply',data:{id:-100}},
  {type:'forward',data:{id:'resource-1'}},
 ]}))
 assert.deepEqual(result.message.parts.map(x=>x.type),['image','image','image','audio','video','file','reply','forward'])
 assert.equal(result.media[0].source.url,'https://example.com/original.png')
 assert.equal(result.media[0].source.file,'original-key')
 assert.equal(result.media[1].source.url,'https://example.com/animation.gif')
 assert.equal(result.media[5].source.name,'source.html')
 assert.equal(new Set(result.media.map(x=>x.id)).size,6)
 assert.equal(result.message.parts[6].messageId,'-100')
})
test('JSON and XML platform-share cards retain their complete untrusted content',()=>{
 const json='{"app":"com.bilibili.app","meta":{"url":"https://b23.tv/example"},"note":"quoted content"}'
 const xml='<msg><url>https://example.com/video</url></msg>'
 const result=parse(message({message:[{type:'json',data:{data:json}},{type:'xml',data:{data:xml}}]}))
 assert.deepEqual(result.message.parts,[{type:'card',format:'json',content:json},{type:'card',format:'xml',content:xml}])
})
test('malformed and oversized admitted content is rejected instead of silently truncated',()=>{
 for(const raw of [message({time:NaN}),message({user_id:0}),message({message_id:undefined}),message({message:[{type:'text',data:{text:10}}]}),message({message:[{type:'reply',data:{id:'bad'}}]}),message({message:[{type:'at',data:{qq:'bad'}}]}),message({message:[{type:'forward',data:{id:''}}]}),message({message:[{type:'json',data:{data:4}}]})])assert.throws(()=>parse(raw))
 assert.throws(()=>parse(message(),spec({maxTextChars:1})),/text-limit/)
 assert.equal(parse({post_type:'notice'}),null)
 assert.equal(parse(message({message_type:'unknown'})),null)
})
