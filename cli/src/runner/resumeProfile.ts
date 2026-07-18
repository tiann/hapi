import { createHash } from 'node:crypto'

export type ResumeProfile = {
    provider: string
    path: string
    model?: string | null
    effort?: string | null
    modelReasoningEffort?: string | null
    serviceTier?: string | null
    permissionMode?: string | null
}

export function createResumeProfileFingerprint(profile: ResumeProfile): string {
    return createHash('sha256').update(JSON.stringify({
        provider: profile.provider,
        path: profile.path,
        model: profile.model ?? null,
        effort: profile.effort ?? null,
        modelReasoningEffort: profile.modelReasoningEffort ?? null,
        serviceTier: profile.serviceTier ?? null,
        permissionMode: profile.permissionMode ?? 'default'
    })).digest('hex')
}
