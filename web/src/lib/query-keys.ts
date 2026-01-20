export const queryKeys = {
    sessions: ['sessions'] as const,
    session: (sessionId: string) => ['session', sessionId] as const,
    messages: (sessionId: string) => ['messages', sessionId] as const,
    machines: ['machines'] as const,
    gitStatus: (sessionId: string) => ['git-status', sessionId] as const,
    sessionFiles: (sessionId: string, query: string) => ['session-files', sessionId, query] as const,
    sessionFile: (sessionId: string, path: string) => ['session-file', sessionId, path] as const,
    gitFileDiff: (sessionId: string, path: string, staged?: boolean) => [
        'git-file-diff',
        sessionId,
        path,
        staged ? 'staged' : 'unstaged'
    ] as const,
    slashCommands: (sessionId: string) => ['slash-commands', sessionId] as const,
    skills: (sessionId: string) => ['skills', sessionId] as const,
}
