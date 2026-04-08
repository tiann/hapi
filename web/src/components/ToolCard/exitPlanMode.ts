import type { ExitPlanImplementationMode } from '@/types/api'
import { isObject } from '@hapi/protocol'

export function isExitPlanModeToolName(toolName: string): boolean {
    return toolName === 'exit_plan_mode' || toolName === 'ExitPlanMode'
}

export function parseExitPlanModeInput(input: unknown): { plan: string | null } {
    if (!isObject(input)) return { plan: null }
    return {
        plan: typeof input.plan === 'string' && input.plan.trim().length > 0
            ? input.plan
            : null
    }
}

export function isExitPlanImplementationMode(value: unknown): value is ExitPlanImplementationMode {
    return value === 'keep_context' || value === 'clear_context'
}

export function getExitPlanImplementationModeLabel(
    mode: ExitPlanImplementationMode,
    t: (key: string) => string
): string {
    return mode === 'keep_context'
        ? t('tool.exitPlanMode.keepContext.title')
        : t('tool.exitPlanMode.clearContext.title')
}

export function getExitPlanImplementationModeDescription(
    mode: ExitPlanImplementationMode,
    t: (key: string) => string
): string {
    return mode === 'keep_context'
        ? t('tool.exitPlanMode.keepContext.description')
        : t('tool.exitPlanMode.clearContext.description')
}

export function getExitPlanImplementationModes(): ExitPlanImplementationMode[] {
    return ['keep_context', 'clear_context']
}

type ExitPlanPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions'

export function getExitPlanPermissionModes(): ExitPlanPermissionMode[] {
    return ['default', 'acceptEdits', 'bypassPermissions']
}

export function getExitPlanPermissionModeLabel(
    mode: ExitPlanPermissionMode,
    t: (key: string) => string
): string {
    switch (mode) {
        case 'default': return t('tool.exitPlanMode.permissionMode.default.title')
        case 'acceptEdits': return t('tool.exitPlanMode.permissionMode.acceptEdits.title')
        case 'bypassPermissions': return t('tool.exitPlanMode.permissionMode.bypassPermissions.title')
    }
}

export function getExitPlanPermissionModeDescription(
    mode: ExitPlanPermissionMode,
    t: (key: string) => string
): string {
    switch (mode) {
        case 'default': return t('tool.exitPlanMode.permissionMode.default.description')
        case 'acceptEdits': return t('tool.exitPlanMode.permissionMode.acceptEdits.description')
        case 'bypassPermissions': return t('tool.exitPlanMode.permissionMode.bypassPermissions.description')
    }
}
