export const queryKeys = {
    sessions: ['sessions'] as const,
    session: (sessionId: string) => ['session', sessionId] as const,
    messages: (sessionId: string) => ['messages', sessionId] as const,
    machines: ['machines'] as const,
}
