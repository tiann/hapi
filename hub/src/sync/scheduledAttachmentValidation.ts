export class ScheduledAttachmentValidationError extends Error {
    readonly code = 'scheduled_attachment_invalid' as const

    constructor(message: string) {
        super(message)
        this.name = 'ScheduledAttachmentValidationError'
    }
}
