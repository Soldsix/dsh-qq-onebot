/** Explicit strict client descriptors; Host authorization and validation remain independent. */
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol/types'
import type { ControlSnapshot, SaveRequest, RestartRequest } from '../control-types.ts'
import { saveSchema, restartSchema, snapshotSchema } from '../control-codecs.ts'

declare module '@deepseek-ai/dsh-typert-protocol/types' {
  interface TypertRemoteNamespaceMap {
    /** Owner-only native page API, installed by this bundle's client entry. */
    qqOnebotControl: {
      describe(): Promise<RemoteResult<ControlSnapshot>>
      save(request: SaveRequest): Promise<RemoteResult<ControlSnapshot>>
      restart(request: RestartRequest): Promise<RemoteResult<ControlSnapshot>>
    }
  }
}

/** The native Client requires strict codecs even when the Host loads source descriptors. */
export const controlRemote: TypertRemoteContribution = {
  package: 'dsh-qq-onebot',
  descriptors: ['describe', 'save', 'restart'].map(method => ({
    id: `qqOnebotControl/${method}`, service: 'qqOnebotControl', namespace: 'qqOnebotControl', method,
    invocation: { kind: 'direct' },
    parameters: method === 'describe' ? [] : [{ name: 'request', wire: 'request', source: 'json', codec: {
      mode: 'strict', typeSymbol: `dsh-qq-onebot#${method}Request`, create: () => method === 'save' ? saveSchema : restartSchema,
    } }],
    result: { mode: 'strict', typeSymbol: 'dsh-qq-onebot#ControlSnapshot', create: () => snapshotSchema },
  })),
}
