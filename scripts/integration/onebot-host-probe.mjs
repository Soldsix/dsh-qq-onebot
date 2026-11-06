/** Test-only Cordis consumer: public services, synthetic input, local files only. */
import {writeFile,rename} from 'node:fs/promises'
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
  const receipt=await ctx.im.send({scope:message.scope,operationId:'isolated-host-operation',parts:[{type:'reply',messageId:message.messageId},{type:'text',text:'isolated DSH reply'}]},signal)
  const forms=ctx.settings.describe({redactSecrets:true})
  await record(config.resultPath,{
   received:true,messageId:message.messageId,directedToBot:message.directedToBot,
   receipt,generatedSettingsForm:forms.some(form=>form.ns==='qq-onebot-transport'),
   modelRequests:0,qqMessagesSent:0,transport:'isolated-loopback-OneBot',
  })
 },()=>true))
}
