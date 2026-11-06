import test from 'node:test'
import assert from 'node:assert/strict'
import {Config,resolveConfig} from '../dist/config.js'
import {spec} from './helpers.mjs'

test('a disabled standalone installation does not read credentials',()=>{
 const env=new Proxy({}, {get(){throw Error('Credential read while disabled')}})
 assert.equal(resolveConfig(Config({}),env),null)
})
test('configuration resolves identity and keeps the token out of JSON',async()=>{
 const result=spec()
 assert.equal(result.account.accountId,'90000001')
 assert.equal(result.account.tenantId,'qq')
 assert.equal(await result.accessToken(),'fixture-only-token')
 assert.ok(!JSON.stringify(result).includes('fixture-only-token'))
 assert.equal(spec({mode:'reverse',reversePort:0}).reversePort,0)
})
test('identity, endpoint, credential and resource misconfigurations fail before connecting',()=>{
 const cases=[{accountId:''},{accountId:'01'},{accountId:'9007199254740993'},{allowedGroups:['9007199254740993']},{allowedGroups:['bad']},{allowedGroups:['1','1']},{privateUsers:['2','2']},{reconnectMinMs:100,reconnectMaxMs:20},{maxMediaBytes:10,maxStoredMediaBytes:5},{accessTokenEnv:'bad-name'},{forwardUrl:'http://127.0.0.1'},{forwardUrl:'ws://example.com'},{forwardUrl:'wss://name:password@example.com'},{forwardUrl:'wss://example.com/?access_token=bad'},{reversePath:'relative'},{reversePath:'/onebot?token=x'}]
 for(const value of cases)assert.throws(()=>spec(value),JSON.stringify(value))
 for(const token of [undefined,'','bad\r\nvalue'])assert.throws(()=>resolveConfig(Config({enabled:true,accountId:'90000001'}),{ONEBOT_ACCESS_TOKEN:token}))
 assert.throws(()=>Config({maxPendingActions:0}))
 assert.throws(()=>Config({reversePort:70000}))
 assert.throws(()=>Config({mode:'invalid'}))
})

test('host credentials are re-resolved and invalid secret values never enter diagnostics',async()=>{
 let value='first-fixture-token',calls=0
 const result=resolveConfig(Config({enabled:true,accountId:'90000001'}),{},async reference=>{assert.equal(reference,'ONEBOT_ACCESS_TOKEN');calls++;return value})
 assert.equal(calls,0)
 assert.equal(await result.accessToken(),'first-fixture-token')
 value='second-fixture-token'
 assert.equal(await result.accessToken(),'second-fixture-token')
 value='invalid\r\nsecret'
 await assert.rejects(result.accessToken(),error=>!error.message.includes('invalid\r\nsecret'))
 assert.equal(calls,3)
})
