function normalizeFlavor(flavor?: string | null): string | null {
    const normalized = flavor?.trim().toLowerCase()
    return normalized || null
}

const SESSION_META_BADGE_BASE = 'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium leading-none'

export const SESSION_ACTIVITY_BADGE = `${SESSION_META_BADGE_BASE} border-[var(--app-badge-info-border)] bg-[var(--app-badge-info-bg)] text-[var(--app-badge-info-text)]`
export const SESSION_PENDING_BADGE = `${SESSION_META_BADGE_BASE} border-[var(--app-badge-warning-border)] bg-[var(--app-badge-warning-bg)] text-[var(--app-badge-warning-text)]`

export function isCodexFamilyFlavor(flavor?: string | null): boolean {
    const normalized = normalizeFlavor(flavor)
    return normalized === 'codex' || normalized === 'gemini' || normalized === 'opencode'
}

export function isClaudeFlavor(flavor?: string | null): boolean {
    return normalizeFlavor(flavor) === 'claude'
}

export function isCursorFlavor(flavor?: string | null): boolean {
    return normalizeFlavor(flavor) === 'cursor'
}

export function isKnownFlavor(flavor?: string | null): boolean {
    return isClaudeFlavor(flavor) || isCodexFamilyFlavor(flavor) || isCursorFlavor(flavor)
}

const FLAVOR_TEXT_CLASSES: Record<string, string> = {
    claude: 'text-[var(--app-flavor-claude-text)] font-medium',
    codex: 'text-[var(--app-flavor-codex-text)] font-medium',
    gemini: 'text-[var(--app-flavor-gemini-text)] font-medium',
    opencode: 'text-[var(--app-flavor-opencode-text)] font-medium',
    cursor: 'text-[var(--app-flavor-cursor-text)] font-medium'
}

export function getFlavorTextClass(flavor?: string | null): string {
    const normalized = normalizeFlavor(flavor)
    return normalized ? (FLAVOR_TEXT_CLASSES[normalized] ?? 'text-[var(--app-hint)] font-medium') : 'text-[var(--app-hint)] font-medium'
}

export const META_DOT_SEPARATOR_CLASS = 'text-[var(--app-hint)] opacity-40'

export function formatEffortLabel(effort?: string | null): string | null {
    const normalized = effort?.trim()
    if (!normalized) return null

    return normalized
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ')
}

export function supportsModelChange(flavor?: string | null): boolean {
    const normalized = normalizeFlavor(flavor)
    return normalized === 'claude' || normalized === 'gemini'
}
