import type { Metadata } from '@/types/api'

const SESSION_ID_FIELD_BY_FLAVOR = {
    claude: 'claudeSessionId',
    codex: 'codexSessionId',
    gemini: 'geminiSessionId',
    opencode: 'opencodeSessionId',
    grok: 'grokSessionId',
    cursor: 'cursorSessionId',
    kimi: 'kimiSessionId',
    pi: 'piSessionId'
} as const satisfies Record<string, keyof Metadata>

const SESSION_ID_FIELDS = Object.values(SESSION_ID_FIELD_BY_FLAVOR)

function readSessionId(metadata: Metadata, field: keyof Metadata | undefined): string | null {
    if (!field) return null
    const value = metadata[field]
    return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function getAgentSessionId(metadata: Metadata | null | undefined): string | null {
    if (!metadata) return null

    const flavor = metadata.flavor?.trim().toLowerCase()
    const flavorField = flavor
        ? SESSION_ID_FIELD_BY_FLAVOR[flavor as keyof typeof SESSION_ID_FIELD_BY_FLAVOR]
        : undefined
    const flavorSessionId = readSessionId(metadata, flavorField)
    if (flavorSessionId) return flavorSessionId

    for (const field of SESSION_ID_FIELDS) {
        const sessionId = readSessionId(metadata, field)
        if (sessionId) return sessionId
    }

    return null
}

const RESUME_COMMAND_BY_FLAVOR = {
    claude: (id: string) => `claude --resume ${id}`,
    codex: (id: string) => `codex resume ${id}`,
    opencode: (id: string) => `opencode -s ${id}`,
    grok: (id: string) => `grok --resume ${id}`,
    cursor: (id: string) => `agent resume ${id}`,
    kimi: (id: string) => `kimi --session ${id}`,
    pi: (id: string) => `pi --session-id ${id}`
} as const satisfies Partial<Record<keyof typeof SESSION_ID_FIELD_BY_FLAVOR, (id: string) => string>>

const SAFE_RESUME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

export function getAgentResumeCommand(metadata: Metadata | null | undefined): string | null {
    if (!metadata) return null

    const flavor = metadata.flavor?.trim().toLowerCase()
    if (!flavor || !(flavor in RESUME_COMMAND_BY_FLAVOR)) return null

    const sessionId = readSessionId(
        metadata,
        SESSION_ID_FIELD_BY_FLAVOR[flavor as keyof typeof SESSION_ID_FIELD_BY_FLAVOR]
    )
    if (!sessionId) return null

    return getResumeCommand(flavor, sessionId)
}

export function getResumeCommand(flavor: string | null | undefined, sessionId: string | null | undefined): string | null {
    const normalizedFlavor = flavor?.trim().toLowerCase()
    const normalizedSessionId = sessionId?.trim()
    if (
        !normalizedFlavor
        || !normalizedSessionId
        || !SAFE_RESUME_ID_PATTERN.test(normalizedSessionId)
        || !(normalizedFlavor in RESUME_COMMAND_BY_FLAVOR)
    ) {
        return null
    }

    return RESUME_COMMAND_BY_FLAVOR[normalizedFlavor as keyof typeof RESUME_COMMAND_BY_FLAVOR](normalizedSessionId)
}
