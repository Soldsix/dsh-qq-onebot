import {Config,resolveConfig} from '../dist/config.js'
export function spec(overrides={}){
 return resolveConfig(Config({enabled:true,accountId:'90000001',allowedGroups:['90000100'],allowPrivate:true,connectTimeoutMs:1000,actionTimeoutMs:100,healthIntervalMs:100,reconnectMinMs:20,reconnectMaxMs:100,shutdownTimeoutMs:1000,...overrides}),{ONEBOT_ACCESS_TOKEN:'fixture-only-token'})
}
export function message(overrides={}){
 return {time:1000,self_id:90000001,post_type:'message',message_type:'group',group_id:90000100,user_id:90000002,message_id:10,message:[{type:'text',data:{text:'hello'}}],...overrides}
}
export function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
