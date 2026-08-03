export type CapabilityState = 'unknown' | 'supported' | 'unsupported'

export type ConversationHistoryCapabilityStates = {
    forkCurrent: CapabilityState
    forkAtMessage: CapabilityState
    rewindToMessage: CapabilityState
}

export type ConversationHistoryCapabilities = {
    forkCurrent?: boolean
    forkAtMessage?: boolean
    rewindToMessage?: boolean
}

/** Only `supported` becomes true in session metadata; never optimistic. */
export function toConversationHistoryCapabilities(
    states: ConversationHistoryCapabilityStates
): ConversationHistoryCapabilities | undefined {
    const capabilities: ConversationHistoryCapabilities = {}
    if (states.forkCurrent === 'supported') capabilities.forkCurrent = true
    if (states.forkAtMessage === 'supported') capabilities.forkAtMessage = true
    if (states.rewindToMessage === 'supported') capabilities.rewindToMessage = true
    return Object.keys(capabilities).length > 0 ? capabilities : undefined
}

export function markUnsupported(
    states: ConversationHistoryCapabilityStates,
    key: keyof ConversationHistoryCapabilityStates
): ConversationHistoryCapabilityStates {
    if (states[key] === 'unsupported') return states
    return { ...states, [key]: 'unsupported' }
}

export function markSupported(
    states: ConversationHistoryCapabilityStates,
    key: keyof ConversationHistoryCapabilityStates
): ConversationHistoryCapabilityStates {
    if (states[key] === 'unsupported') return states
    return { ...states, [key]: 'supported' }
}

export const UNSUPPORTED_CONVERSATION_HISTORY: ConversationHistoryCapabilityStates = {
    forkCurrent: 'unsupported',
    forkAtMessage: 'unsupported',
    rewindToMessage: 'unsupported'
}

export const CLAUDE_CONVERSATION_HISTORY: ConversationHistoryCapabilityStates = {
    forkCurrent: 'supported',
    forkAtMessage: 'unsupported',
    rewindToMessage: 'unsupported'
}

export const CODEX_CONVERSATION_HISTORY_INITIAL: ConversationHistoryCapabilityStates = {
    forkCurrent: 'unknown',
    forkAtMessage: 'unknown',
    rewindToMessage: 'unknown'
}

export const GROK_CONVERSATION_HISTORY_INITIAL: ConversationHistoryCapabilityStates = {
    forkCurrent: 'unknown',
    forkAtMessage: 'unknown',
    rewindToMessage: 'unknown'
}

export const PI_CONVERSATION_HISTORY_INITIAL: ConversationHistoryCapabilityStates = {
    forkCurrent: 'unknown',
    forkAtMessage: 'unknown',
    rewindToMessage: 'unknown'
}
