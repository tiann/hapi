import type { PermissionModeTone } from '@hapi/protocol'

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

export function getFlavorTextClass(flavor?: string | null): string {
    const key = flavor?.trim()
    switch (key) {
        case 'claude':
            return 'text-[var(--app-flavor-claude)]'
        case 'codex':
            return 'text-[var(--app-flavor-codex)]'
        case 'gemini':
            return 'text-[var(--app-flavor-gemini)]'
        case 'opencode':
            return 'text-[var(--app-flavor-opencode)]'
        default:
            return 'text-[var(--app-hint)]'
    }
}
