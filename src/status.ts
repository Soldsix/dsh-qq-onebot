/** Client-safe connection facts; socket admission alone does not prove QQ login. */

/** Sanitized transport state without endpoints, credentials or message bodies. */
export interface OneBotStatus {
  readonly phase: 'connecting' | 'verifying' | 'online' | 'offline' | 'blocked' | 'stopped'
  readonly connected: boolean
  readonly verified: boolean
  readonly online: boolean
  readonly received: number
  readonly duplicates: number
  readonly rejected: number
  readonly notices: number
  readonly activeDeliveries: number
  readonly storedReferences: number
  readonly storedMediaBytes: number
  readonly fault: string | null
}
