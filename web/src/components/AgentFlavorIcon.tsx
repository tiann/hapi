// Deep component imports on purpose: the package root re-exports ./features,
// which pulls in uninstalled peer deps (@lobehub/ui, antd). The Mono/Color
// components only depend on react and es-toolkit.
import AntigravityColor from '@lobehub/icons/es/Antigravity/components/Color'
import ClaudeColor from '@lobehub/icons/es/Claude/components/Color'
import CodexColor from '@lobehub/icons/es/Codex/components/Color'
import CursorMono from '@lobehub/icons/es/Cursor/components/Mono'
import DeepSeekColor from '@lobehub/icons/es/DeepSeek/components/Color'
import GeminiColor from '@lobehub/icons/es/Gemini/components/Color'
import GrokMono from '@lobehub/icons/es/Grok/components/Mono'
import KimiMono from '@lobehub/icons/es/Kimi/components/Mono'
import OpenCodeMono from '@lobehub/icons/es/OpenCode/components/Mono'
import type { IconType } from '@lobehub/icons/es/types'
import { CopilotIcon } from '@/components/icons/CopilotIcon'

// Brand logos per agent flavor. Color variant where it stays visible on both
// light and dark surfaces (claude/codex/gemini); Mono (currentColor) where the
// package ships no Color variant — or where, like KimiColor, the main glyph is
// hard-coded #fff and would vanish on the default light theme.
const FLAVOR_LOGOS: Record<string, IconType> = {
    agy: AntigravityColor,
    claude: ClaudeColor,
    codex: CodexColor,
    dsh: DeepSeekColor,
    cursor: CursorMono,
    gemini: GeminiColor,
    grok: GrokMono,
    kimi: KimiMono,
    opencode: OpenCodeMono,
}

function PiLogo() {
    return (
        <svg viewBox="0 0 800 800" width="100%" height="100%" fill="currentColor">
            <path fillRule="evenodd" d="M165.29 165.29h352.07V400H400v117.36H282.65v117.36H165.29zM282.65 282.65V400H400V282.65z" />
            <path d="M517.36 400h117.36v234.72H517.36z" />
        </svg>
    )
}

/** Berry Agent has no upstream icon pack entry; ship a minimal geometric
 *  berry mark (currentColor) in the PiLogo tradition. */
function BerryLogo() {
    return (
        <svg viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor">
            <path d="M12 4.2c.2-1 1-1.8 2-2l.4 1.5c.8-.5 1.8-.6 2.6-.1-.3.9-1 1.5-1.9 1.7.9.4 1.5 1.1 1.7 2-.9.2-1.8 0-2.4-.6l-.6.9a6.6 6.6 0 0 0-1.8-.4V4.2z" />
            <path d="M12 21.4c-3.9 0-6.9-2.6-6.9-6s3-6 6.9-6 6.9 2.6 6.9 6-3 6-6.9 6z" />
        </svg>
    )
}

const UNKNOWN_FLAVOR_BADGE = {
    label: 'Un',
    colors: 'bg-[var(--app-secondary-bg)] text-[var(--app-hint)]',
}

export function AgentFlavorIcon({ flavor, className }: { flavor?: string | null; className?: string }) {
    const normalized = (flavor ?? '').trim().toLowerCase()
    const sizeClass = className ?? 'h-4 w-4'
    if (normalized === 'copilot') {
        return (
            <span
                aria-hidden="true"
                className={`inline-flex items-center justify-center leading-none text-[#24292f] dark:text-[#e6edf3] ${sizeClass}`}
            >
                <CopilotIcon size="100%" />
            </span>
        )
    }

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

    if (normalized === 'pi') {
        return (
            <span
                aria-hidden="true"
                className={`inline-flex items-center justify-center leading-none text-[var(--app-fg)] ${sizeClass}`}
            >
                <PiLogo />
            </span>
        )
    }

    if (normalized === 'berry') {
        return (
            <span
                aria-hidden="true"
                className={`inline-flex items-center justify-center leading-none text-[var(--app-fg)] ${sizeClass}`}
            >
                <BerryLogo />
            </span>
        )
    }

    const badge = UNKNOWN_FLAVOR_BADGE
    return (
        <span
            aria-hidden="true"
            className={`inline-flex items-center justify-center rounded-sm text-[8px] font-semibold leading-none ${badge.colors} ${sizeClass}`}
        >
            {badge.label}
        </span>
    )
}
