/** Test-only Cordis consumer: public services, synthetic input, local files only. */
import {writeFile,rename} from 'node:fs/promises'
import assert from 'node:assert/strict'
export const name='onebot-host-probe'
export const inject=['im','qqOnebot','settings']
async function record(path,data){await writeFile(path+'.tmp',JSON.stringify(data,null,2)+'\n');await rename(path+'.tmp',path)}
export function apply(ctx,config){
 let ready=false
 const status=async state=>{
  if(ready||!state.online)return
  ready=true
  await record(config.readyPath,{online:true,verified:state.verified})
 }
 ctx.on('qq-onebot/status',status)
 void status(ctx.qqOnebot.status())
 ctx.effect(()=>ctx.im.subscribe(async(message,signal)=>{
  const resource=message.parts.find(part=>part.type==='forward');assert.ok(resource)
  const before=await ctx.qqOnebot.readForward({...message.scope,peerId:'90000101'},message.messageId,resource.resourceId,signal);assert.notEqual(before.status,'resolved')
  const forward=await ctx.qqOnebot.readForward(message.scope,message.messageId,resource.resourceId,signal);assert.equal(forward.status,'resolved');assert.equal(forward.nodes[0].parts[0].text,'NATIVE_FORWARD_ORIGINAL');assert.equal(forward.nodes[0].parts[1].messageId,'-44')
  const attachment=forward.nodes[0].parts[2].attachmentId;assert.equal(ctx.qqOnebot.mediaSource(message.scope,attachment).url,'https://example.invalid/original.gif');assert.equal(ctx.qqOnebot.mediaSource({...message.scope,kind:'private'},attachment),undefined)
  const nested=await ctx.qqOnebot.readForward(message.scope,message.messageId,forward.nodes[0].parts[3].resourceId,signal);assert.equal(nested.status,'resolved');assert.equal(nested.nodes[0].parts[0].text,'NATIVE_NESTED_ORIGINAL')
  assert.equal((await ctx.qqOnebot.readForward(message.scope,message.messageId,resource.resourceId,signal)).nodes[0].parts[0].text,'NATIVE_FORWARD_ORIGINAL')
  const receipt=await ctx.im.send({scope:message.scope,operationId:'isolated-host-operation',parts:[{type:'reply',messageId:message.messageId},{type:'text',text:'isolated DSH reply'}]},signal)
  const forms=ctx.settings.describe({redactSecrets:true})
  await record(config.resultPath,{
   received:true,messageId:message.messageId,directedToBot:message.directedToBot,
   receipt,generatedSettingsForm:forms.some(form=>form.ns==='qq-onebot-transport'),settingsNamespaces:forms.map(form=>form.ns),forwardReads:true,forwardScopes:true,forwardMedia:true,
   modelRequests:0,qqMessagesSent:0,transport:'isolated-loopback-OneBot',
  })
 },()=>true))
}
