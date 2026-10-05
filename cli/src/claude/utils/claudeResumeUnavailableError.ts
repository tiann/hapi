/** Thrown when a resume id was requested but the on-disk transcript is gone. */
export class ClaudeResumeUnavailableError extends Error {
    readonly code = 'resume_unavailable' as const
    readonly resumeSessionId: string

    constructor(resumeSessionId: string) {
        super(
            `Claude resume unavailable: transcript for ${resumeSessionId} was not found ` +
            `under ~/.claude/projects (refusing to mint a new session id)`
        )
        this.name = 'ClaudeResumeUnavailableError'
        this.resumeSessionId = resumeSessionId
    }
}
