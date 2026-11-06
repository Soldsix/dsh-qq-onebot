/** Native Client descriptors require strict, field-complete wire validation. */
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {Config} from '../dist/config.js'
import {saveSchema,restartSchema,snapshotSchema} from '../dist/control-codecs.js'
const revision='a'.repeat(64)
test('strict edit codecs preserve valid minimal edits and reject undeclared wire data',()=>{
 const value={revision,patch:{enabled:false,allowedGroups:['90000100']}}
 assert.deepEqual(saveSchema.parse(value),value)
 for(const input of [{patch:{}},{revision:'invalid',patch:{}},{revision,patch:{accessToken:'synthetic-only'}},{revision,patch:{maxSegments:1.5}},{revision,patch:{mode:'other'}},{revision,patch:{},secret:'synthetic-only'}])assert.throws(()=>saveSchema.parse(input))
 assert.deepEqual(restartSchema.parse({revision}),{revision})
 assert.throws(()=>restartSchema.parse({revision,enabled:false}))
})
test('snapshot codec validates complete form and status evidence without silently dropping fields',()=>{
 const value={config:Config({}),revision,appliedRevision:null,entryActive:true,entryDisabled:false,status:null,credential:'configured',overriddenFields:[],refreshMs:3000}
 assert.deepEqual(snapshotSchema.parse(value),value)
 for(const input of [{...value,credential:'online'},{...value,refreshMs:0},{...value,config:{...value.config,accessToken:'synthetic-only'}},{...value,overriddenFields:['secret']},{...value,status:{phase:'online',online:true}}])assert.throws(()=>snapshotSchema.parse(input))
})
