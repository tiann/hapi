import { CREATABLE_AGENT_FLAVORS } from '@hapi/protocol'
import {
    CLAUDE_EFFORT_OPTIONS,
    CODEX_REASONING_EFFORT_OPTIONS,
    MODEL_OPTIONS,
    type AgentType,
    type CodexReasoningEffort,
    type LaunchEffort
} from './types'

const AGENT_STORAGE_KEY = 'hapi:newSession:agent'
const YOLO_STORAGE_KEY = 'hapi:newSession:yolo'
const LAUNCH_SETTINGS_STORAGE_PREFIX = 'hapi:newSession:launchSettings:v1'

export type PreferredLaunchSettings = {
    model: string
    cursorSelectedBase: string
    effort: LaunchEffort
    modelReasoningEffort: CodexReasoningEffort
}

// Only launchable flavors are valid defaults; a stale 'gemini' preference
// (no longer creatable) falls back to 'claude'.
const VALID_AGENTS = CREATABLE_AGENT_FLAVORS

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

function launchSettingsStorageKey(machineId: string, agent: AgentType): string {
    return `${LAUNCH_SETTINGS_STORAGE_PREFIX}:${encodeURIComponent(machineId)}:${agent}`
}

export function loadPreferredLaunchSettings(
    machineId: string,
    agent: AgentType
): PreferredLaunchSettings | null {
    try {
        const raw = localStorage.getItem(launchSettingsStorageKey(machineId, agent))
        if (!raw) {
            return null
        }
        const parsed = JSON.parse(raw) as Partial<PreferredLaunchSettings>
        if (!parsed || typeof parsed !== 'object' || typeof parsed.model !== 'string') {
            return null
        }
        return {
            model: parsed.model,
            cursorSelectedBase: typeof parsed.cursorSelectedBase === 'string'
                ? parsed.cursorSelectedBase
                : 'auto',
            effort: typeof parsed.effort === 'string' ? parsed.effort : 'auto',
            modelReasoningEffort: typeof parsed.modelReasoningEffort === 'string'
                ? parsed.modelReasoningEffort
                : 'default'
        }
    } catch {
        return null
    }
}

export function savePreferredLaunchSettings(
    machineId: string,
    agent: AgentType,
    settings: PreferredLaunchSettings
): void {
    try {
        localStorage.setItem(
            launchSettingsStorageKey(machineId, agent),
            JSON.stringify(settings)
        )
    } catch {
        // Ignore storage errors
    }
}

function resolvePreferredOptionValue(
    preferredValue: string,
    availableValues: readonly string[],
    fallbackValue: string
): string {
    return availableValues.includes(preferredValue) ? preferredValue : fallbackValue
}

export function resolvePreferredLaunchSettings(
    agent: AgentType,
    preferred: PreferredLaunchSettings | null
): PreferredLaunchSettings {
    const preferredModel = preferred?.model ?? 'auto'
    const staticModelValues = MODEL_OPTIONS[agent].map((option) => option.value)
    const model = staticModelValues.length > 0 && agent !== 'codex'
        ? resolvePreferredOptionValue(preferredModel, staticModelValues, 'auto')
        : preferredModel
    const effort = agent === 'claude'
        ? resolvePreferredOptionValue(
            preferred?.effort ?? 'auto',
            CLAUDE_EFFORT_OPTIONS.map((option) => option.value),
            'auto'
        )
        : (preferred?.effort ?? 'auto')
    const modelReasoningEffort = agent === 'opencode'
        ? resolvePreferredOptionValue(
            preferred?.modelReasoningEffort ?? 'default',
            CODEX_REASONING_EFFORT_OPTIONS
                .filter((option) => option.value !== 'xhigh')
                .map((option) => option.value),
            'default'
        )
        : (preferred?.modelReasoningEffort ?? 'default')

    return {
        model,
        cursorSelectedBase: preferred?.cursorSelectedBase ?? 'auto',
        effort,
        modelReasoningEffort
    }
}
