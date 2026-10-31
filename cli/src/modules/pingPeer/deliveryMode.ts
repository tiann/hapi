import { z } from 'zod'
import { MessageDeliveryModeSchema } from '@hapi/protocol'

// Auto is a peer-sender policy, not a hub/wire delivery mode. Resolve it before
// submission so ordinary chat sends and persisted queue semantics stay unchanged.
export const PeerDeliveryModeSchema = z.enum(['auto', ...MessageDeliveryModeSchema.options])
export type PeerDeliveryMode = z.infer<typeof PeerDeliveryModeSchema>
