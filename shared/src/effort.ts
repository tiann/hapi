// Effort levels Claude Code's `--effort` flag accepts, in ascending order.
// "auto"/null is hapi's sentinel for omitting --effort (model default), not a level here.
export const CLAUDE_EFFORT_LABELS = {
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'XHigh',
    max: 'Max'
} as const

export type ClaudeEffortLevel = keyof typeof CLAUDE_EFFORT_LABELS
export const CLAUDE_EFFORT_LEVELS = Object.keys(CLAUDE_EFFORT_LABELS) as ClaudeEffortLevel[]
