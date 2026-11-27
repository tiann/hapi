// Deep component imports on purpose: the package root re-exports ./features,
// which pulls in uninstalled peer deps (@lobehub/ui, antd). The Mono/Color
// components only depend on react and es-toolkit.
import AntigravityColor from '@lobehub/icons/es/Antigravity/components/Color'
import ClaudeColor from '@lobehub/icons/es/Claude/components/Color'
import CodexMono from '@lobehub/icons/es/Codex/components/Mono'
import CursorMono from '@lobehub/icons/es/Cursor/components/Mono'
import DeepSeekColor from '@lobehub/icons/es/DeepSeek/components/Color'
import GeminiColor from '@lobehub/icons/es/Gemini/components/Color'
import GrokMono from '@lobehub/icons/es/Grok/components/Mono'
import KimiMono from '@lobehub/icons/es/Kimi/components/Mono'
import OpenCodeMono from '@lobehub/icons/es/OpenCode/components/Mono'
import type { IconType } from '@lobehub/icons/es/types'
import { CopilotIcon } from '@/components/icons/CopilotIcon'

// Use Mono (currentColor) for Codex to avoid the Color variant's white tile.
// Kimi also uses Mono because its Color glyph is white.
const FLAVOR_LOGOS: Record<string, IconType> = {
    agy: AntigravityColor,
    claude: ClaudeColor,
    codex: CodexMono,
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
