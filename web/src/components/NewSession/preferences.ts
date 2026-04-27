import type { AgentType, ClaudePermissionMode } from './types'
import { CLAUDE_PERMISSION_MODES } from '@hapi/protocol'

const AGENT_STORAGE_KEY = 'hapi:newSession:agent'
const YOLO_STORAGE_KEY = 'hapi:newSession:yolo'
const PERMISSION_MODE_STORAGE_KEY = 'hapi:newSession:permissionMode'

const VALID_AGENTS: AgentType[] = ['claude', 'codex', 'cursor', 'gemini', 'opencode']

export function loadPreferredAgent(): AgentType {
    try {
        const stored = localStorage.getItem(AGENT_STORAGE_KEY)
        if (stored && VALID_AGENTS.includes(stored as AgentType)) {
            return stored as AgentType
        }
    } catch {
        // Ignore storage errors
    }
    return 'claude'
}

export function savePreferredAgent(agent: AgentType): void {
    try {
        localStorage.setItem(AGENT_STORAGE_KEY, agent)
    } catch {
        // Ignore storage errors
    }
}

export function loadPreferredYoloMode(): boolean {
    try {
        return localStorage.getItem(YOLO_STORAGE_KEY) === 'true'
    } catch {
        return false
    }
}

export function savePreferredYoloMode(enabled: boolean): void {
    try {
        localStorage.setItem(YOLO_STORAGE_KEY, enabled ? 'true' : 'false')
    } catch {
        // Ignore storage errors
    }
}

export function loadPreferredPermissionMode(): ClaudePermissionMode {
    try {
        const stored = localStorage.getItem(PERMISSION_MODE_STORAGE_KEY)
        if (stored && (CLAUDE_PERMISSION_MODES as readonly string[]).includes(stored)) {
            return stored as ClaudePermissionMode
        }
        // Migrate from legacy yolo toggle
        if (localStorage.getItem(YOLO_STORAGE_KEY) === 'true') {
            savePreferredPermissionMode('bypassPermissions')
            return 'bypassPermissions'
        }
    } catch {
        // Ignore storage errors
    }
    return 'default'
}

export function savePreferredPermissionMode(mode: ClaudePermissionMode): void {
    try {
        localStorage.setItem(PERMISSION_MODE_STORAGE_KEY, mode)
    } catch {
        // Ignore storage errors
    }
}
