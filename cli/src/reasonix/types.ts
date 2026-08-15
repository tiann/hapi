import type { ReasonixPermissionMode } from '@hapi/protocol/types'

export type PermissionMode = ReasonixPermissionMode

export interface ReasonixMode {
    permissionMode?: PermissionMode
    model?: string | null
    effort?: string | null
}
