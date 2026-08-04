export const COPILOT_AGENT_MODES = [
    'interactive',
    'plan',
    'autopilot',
] as const

export type CopilotAgentMode = typeof COPILOT_AGENT_MODES[number]

export const COPILOT_AGENT_MODE_LABELS: Record<CopilotAgentMode, string> = {
    interactive: 'Interactive',
    plan: 'Plan',
    autopilot: 'Autopilot',
}

export type CopilotAgentModeOption = {
    mode: CopilotAgentMode
    label: string
}

export function getCopilotAgentModeLabel(mode: CopilotAgentMode): string {
    return COPILOT_AGENT_MODE_LABELS[mode]
}

export function getCopilotAgentModeOptions(): CopilotAgentModeOption[] {
    return COPILOT_AGENT_MODES.map((mode) => ({
        mode,
        label: getCopilotAgentModeLabel(mode)
    }))
}

export function isCopilotAgentMode(value: unknown): value is CopilotAgentMode {
    return typeof value === 'string'
        && (COPILOT_AGENT_MODES as readonly string[]).includes(value)
}

/**
 * Coerce legacy / invalid values. `fleet` was briefly treated as an agent mode;
 * it is a slash command (`/fleet`) orthogonal to interactive/plan/autopilot.
 */
export function normalizeCopilotAgentMode(value: unknown): CopilotAgentMode {
    if (value === 'fleet') {
        return 'interactive'
    }
    return isCopilotAgentMode(value) ? value : 'interactive'
}
