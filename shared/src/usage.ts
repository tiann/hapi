/**
 * Protocol marker for token_count payloads whose input token total already
 * includes cache reads/writes. Consumers must not add cache tokens again.
 */
export const INCLUSIVE_INPUT_TOKEN_USAGE_MARKER = {
    usageSchema: 'hapi.usage.v1',
    inputTokenSemantics: 'includes-cache'
} as const

export type InclusiveInputTokenUsageMarker = typeof INCLUSIVE_INPUT_TOKEN_USAGE_MARKER
