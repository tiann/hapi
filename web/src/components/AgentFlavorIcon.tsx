const FLAVOR_BADGES: Record<string, { label: string; colors: string }> = {
    claude: {
        label: 'Cl',
        colors: 'bg-[#d97706] text-white',
    },
    codex: {
        label: 'Cx',
        colors: 'bg-[#111827] text-white',
    },
    cursor: {
        label: 'Cu',
        colors: 'bg-[#0f766e] text-white',
    },
    gemini: {
        label: 'Gm',
        colors: 'bg-[#2563eb] text-white',
    },
    kimi: {
        label: 'Km',
        colors: 'bg-[#7c3aed] text-white',
    },
    opencode: {
        label: 'Op',
        colors: 'bg-[#15803d] text-white',
    },
}

export function AgentFlavorIcon({ flavor, className }: { flavor?: string | null; className?: string }) {
    const normalized = (flavor ?? 'claude').trim().toLowerCase()
    const badge = FLAVOR_BADGES[normalized] ?? FLAVOR_BADGES.claude

    return (
        <span
            aria-hidden="true"
            className={`inline-flex items-center justify-center rounded-sm text-[8px] font-semibold leading-none ${badge.colors} ${className ?? 'h-4 w-4'}`}
        >
            {badge.label}
        </span>
    )
}
