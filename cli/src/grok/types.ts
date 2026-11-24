import type { PermissionModeOf, Flavors } from '@hapi/protocol/types'

export type PermissionMode = PermissionModeOf<typeof Flavors.grok>

export interface GrokMode {
    permissionMode: PermissionMode
    model?: string | null
    effort?: string | null
}
