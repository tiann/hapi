// Deep component imports on purpose: the package root re-exports ./features,
// which pulls in uninstalled peer deps (@lobehub/ui, antd). The Mono/Color
// components only depend on react and es-toolkit.
import ClaudeColor from '@lobehub/icons/es/Claude/components/Color'
import CodexColor from '@lobehub/icons/es/Codex/components/Color'
import CursorMono from '@lobehub/icons/es/Cursor/components/Mono'
import GeminiColor from '@lobehub/icons/es/Gemini/components/Color'
import GrokMono from '@lobehub/icons/es/Grok/components/Mono'
import KimiMono from '@lobehub/icons/es/Kimi/components/Mono'
import OpenCodeMono from '@lobehub/icons/es/OpenCode/components/Mono'
import type { IconType } from '@lobehub/icons/es/types'

// Brand logos per agent flavor. Color variant where it stays visible on both
// light and dark surfaces (claude/codex/gemini); Mono (currentColor) where the
// package ships no Color variant — or where, like KimiColor, the main glyph is
// hard-coded #fff and would vanish on the default light theme.
const FLAVOR_LOGOS: Record<string, IconType> = {
    claude: ClaudeColor,
    codex: CodexColor,
    cursor: CursorMono,
    gemini: GeminiColor,
    grok: GrokMono,
    kimi: KimiMono,
    opencode: OpenCodeMono,
}

// Letter-badge fallback for flavors without a brand logo in @lobehub/icons
// (pi) and for anything unrecognized.
const FLAVOR_BADGES: Record<string, { label: string; colors: string }> = {
    pi: {
        label: 'Pi',
        colors: 'bg-[#5b21b6] text-white',
    },
}

const UNKNOWN_FLAVOR_BADGE = {
    label: 'Un',
    colors: 'bg-[var(--app-secondary-bg)] text-[var(--app-hint)]',
}

export function AgentFlavorIcon({ flavor, className }: { flavor?: string | null; className?: string }) {
    const normalized = (flavor ?? '').trim().toLowerCase()
    const sizeClass = className ?? 'h-4 w-4'
    const Logo = FLAVOR_LOGOS[normalized]

    if (Logo) {
        return (
            <span
                aria-hidden="true"
                className={`inline-flex items-center justify-center leading-none ${sizeClass}`}
            >
                <Logo size="100%" />
            </span>
        )
    }

    const badge = FLAVOR_BADGES[normalized] ?? UNKNOWN_FLAVOR_BADGE
    return (
        <span
            aria-hidden="true"
            className={`inline-flex items-center justify-center rounded-sm text-[8px] font-semibold leading-none ${badge.colors} ${sizeClass}`}
        >
            {badge.label}
        </span>
    )
}
