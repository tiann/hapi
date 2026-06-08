// Pi thinking levels (from Pi's rpc-types.ts ThinkingLevel)
// Controls how much reasoning/thinking the model performs.
export const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
export type PiThinkingLevel = typeof PI_THINKING_LEVELS[number]

export const PI_THINKING_LEVEL_LABELS: Record<PiThinkingLevel, string> = {
    off: 'Off',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'XHigh',
}
