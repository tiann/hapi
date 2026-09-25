/**
 * Shared visual for rich-composer `@session` chips and peer-delivery sender
 * identity (#1203). Keep these identical so "who sent this" matches @mention.
 */
export const SESSION_MENTION_CHIP_CLASSNAME =
    'mx-0.5 inline-flex max-w-[12rem] items-center truncate rounded-md bg-[var(--app-subtle-bg)] px-1.5 py-0.5 align-baseline text-[0.95em] font-medium text-[var(--app-link)]'

export function formatSessionMentionChipLabel(title: string | null | undefined, sessionId: string): string {
    const trimmed = title?.replace(/\s+/g, ' ').trim()
    return `@${trimmed || sessionId.slice(0, 8)}`
}
