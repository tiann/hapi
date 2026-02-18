import type { PermissionModeTone } from '@hapi/protocol'

export const PERMISSION_TONE_BADGE: Record<PermissionModeTone, string> = {
    neutral: 'text-[var(--app-fg)] bg-[var(--app-subtle-bg)] border-[var(--app-border)]',
    info: 'text-[var(--app-badge-info-text)] bg-[var(--app-badge-info-bg)] border-[var(--app-badge-info-border)]',
    warning: 'text-[var(--app-perm-warning)] bg-[var(--app-badge-warning-bg)] border-[var(--app-badge-warning-border)]',
    danger: 'text-[var(--app-badge-error-text)] bg-[var(--app-badge-error-bg)] border-[var(--app-badge-error-border)]'
}

export const PERMISSION_TONE_TEXT: Record<PermissionModeTone, string> = {
    neutral: 'text-[var(--app-fg)]',
    info: 'text-[var(--app-badge-info-text)]',
    warning: 'text-[var(--app-perm-warning)]',
    danger: 'text-[var(--app-badge-error-text)]'
}

export function isCodexFamilyFlavor(flavor?: string | null): boolean {
    return flavor === 'codex' || flavor === 'gemini' || flavor === 'opencode'
}

export function isClaudeFlavor(flavor?: string | null): boolean {
    return flavor === 'claude'
}

export function isKnownFlavor(flavor?: string | null): boolean {
    return isClaudeFlavor(flavor) || isCodexFamilyFlavor(flavor)
}

type FlavorColors = {
    text: string
    bg: string
    border: string
}

const FLAVOR_COLORS: Record<string, FlavorColors> = {
    claude: {
        text: 'text-[var(--app-flavor-claude)]',
        bg: 'bg-[var(--app-flavor-claude-bg)]',
        border: 'border-[var(--app-flavor-claude-border)]'
    },
    codex: {
        text: 'text-[var(--app-flavor-codex)]',
        bg: 'bg-[var(--app-flavor-codex-bg)]',
        border: 'border-[var(--app-flavor-codex-border)]'
    },
    gemini: {
        text: 'text-[var(--app-flavor-gemini)]',
        bg: 'bg-[var(--app-flavor-gemini-bg)]',
        border: 'border-[var(--app-flavor-gemini-border)]'
    },
    opencode: {
        text: 'text-[var(--app-flavor-opencode)]',
        bg: 'bg-[var(--app-flavor-opencode-bg)]',
        border: 'border-[var(--app-flavor-opencode-border)]'
    }
}

const DEFAULT_FLAVOR_COLORS: FlavorColors = {
    text: 'text-[var(--app-hint)]',
    bg: 'bg-[var(--app-subtle-bg)]',
    border: 'border-[var(--app-border)]'
}

export function getFlavorColors(flavor?: string | null): FlavorColors {
    const key = flavor?.trim()
    if (key && FLAVOR_COLORS[key]) return FLAVOR_COLORS[key]
    return DEFAULT_FLAVOR_COLORS
}

export function getFlavorBadgeClass(flavor?: string | null): string {
    const colors = getFlavorColors(flavor)
    return `${colors.text} ${colors.bg} ${colors.border}`
}

export function getFlavorTextClass(flavor?: string | null): string {
    const colors = getFlavorColors(flavor)
    return colors.text
}

export function getFlavorDotClass(flavor?: string | null): string {
    const key = flavor?.trim()
    switch (key) {
        case 'claude': return 'bg-[var(--app-flavor-claude)]'
        case 'codex': return 'bg-[var(--app-flavor-codex)]'
        case 'gemini': return 'bg-[var(--app-flavor-gemini)]'
        case 'opencode': return 'bg-[var(--app-flavor-opencode)]'
        default: return 'bg-[var(--app-hint)]'
    }
}
