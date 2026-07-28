/** Labels shared by SessionHeader and composer StatusBar for Codex/OpenCode. */

export function formatCodexReasoningLabel(effort?: string | null): string {
    const normalized = effort?.trim().toLowerCase()
    if (!normalized || normalized === 'default') return 'reasoning default'
    return `reasoning ${normalized}`
}

export function shouldShowCodexReasoningLabel(agentFlavor: string | null | undefined): boolean {
    return agentFlavor === 'codex' || agentFlavor === 'opencode'
}
