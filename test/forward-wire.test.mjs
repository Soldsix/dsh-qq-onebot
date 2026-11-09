/** Both documented response families preserve ordered nodes and untrusted claimed identities. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {identifier} from 'dsh-im-kit'
import {parseForward} from '../dist/forward-wire.js'
import {spec} from './helpers.mjs'
const config=spec(),scope={account:config.account,kind:'group',peerId:identifier('im.peer','90000100')}
const text=value=>({type:'text',data:{text:value}}),node=content=>({type:'node',data:{user_id:90000001,nickname:'claimed bot',content}})
function parse(data,patch={}){let serial=0;return parseForward(data,scope,{...config,...patch},()=>identifier('im.attachment','synthetic-'+(++serial)))}

test('standard node arrays retain quotes, inline order, reference-only nodes and exact raw responses',()=>{
 const data={message:[node([text('before\n原文'),{type:'reply',data:{id:'-8'}},{type:'node',data:{user_id:'90000002',nickname:'claimed child',content:[{type:'mface',data:{url:'https://example.invalid/original.gif'}},{type:'forward',data:{id:'nested-resource'}}]}},text('after')]),{type:'node',data:{id:'-19'}}]}
 const parsed=parse(data);assert.deepEqual(parsed.raw,data);assert.equal(parsed.nodes.length,2);assert.equal(parsed.nodeCount,3);assert.equal(parsed.nodes[0].claimedSender.id,'90000001');assert.equal(parsed.nodes[0].parts[1].messageId,'-8');assert.equal(parsed.nodes[0].parts[2].type,'inline-forward');assert.equal(parsed.nodes[0].parts[3].text,'after');assert.equal(parsed.nodes[1].referenceMessageId,'-19');assert.deepEqual(parsed.nodes[1].parts,[]);assert.deepEqual(parsed.resources,['nested-resource']);assert.deepEqual(parsed.media[0].source.scope,scope);assert.equal(parsed.media[0].source.url,'https://example.invalid/original.gif')
})

test('NapCat sender/message envelopes and empty alias fields preserve media and claimed timestamps',()=>{
 const data={messages:[{sender:{user_id:90000003,nickname:'display name'},time:1000,message_id:-9,group_id:99999999,message:[{type:'image',data:{file:'original.png'}},{type:'record',data:{url:'https://example.invalid/original.wav'}},{type:'video',data:{url:'https://example.invalid/original.mp4'}},{type:'file',data:{name:'source.html',url:'https://example.invalid/source.html'}}]},{type:'node',data:{user_id:90000004,nickname:'alias',content:[],message:[text('nonempty message wins over empty alias')]}}]}
 const parsed=parse(data);assert.equal(parsed.nodes[0].sentAt,1000000);assert.equal(parsed.nodes[0].sourceMessageId,'-9');assert.deepEqual(parsed.media.map(value=>value.source.kind),['image','audio','video','file']);assert.ok(parsed.media.every(value=>value.source.scope.peerId==='90000100'));assert.equal(parsed.nodes[1].parts[0].text,'nonempty message wins over empty alias');assert.deepEqual(parsed.raw,data)
})

test('ambiguous, invalid and excessive nodes reject the whole response without truncation',()=>{
 for(const value of[{},[],{messages:'bad'},{message:[text('not a node')]},{message:[node([text('one')])],messages:[node([text('other')])]},{messages:[{content:[text('a')],message:[text('b')]}]},{messages:[{type:'node',data:{id:8,content:[]}}]},{messages:[{user_id:'invalid-id',content:[]}]},{messages:[{time:-1,content:[]}]},{messages:[{message_id:1.5,content:[]}]}])assert.throws(()=>parse(value))
 assert.throws(()=>parse({messages:[node([text('a')]),node([text('b')])]},{maxForwardNodes:1}));assert.throws(()=>parse({messages:[node([{type:'node',data:{content:[text('deeper')]}}])]},{maxForwardDepth:1}));assert.throws(()=>parse({messages:[node([text('over')])]},{maxTextChars:2}));assert.throws(()=>parse({messages:[node([text('one'),text('two')])]},{maxSegments:1}));assert.deepEqual(parse({messages:[]}).nodes,[])
})
