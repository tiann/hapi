import type { ThinkingLevel } from '@mariozechner/pi-agent-core'

export type { ThinkingLevel as PiThinkingLevel }

export type PiPermissionMode = 'default' | 'yolo'

export type PiEnhancedMode = {
    permissionMode: PiPermissionMode
    model?: string
    thinkingLevel?: ThinkingLevel
}
