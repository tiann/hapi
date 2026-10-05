export function buildFileMentionSearchQuery(search: string): string {
    return /[\\/]/.test(search) && !/[*?]/.test(search)
        ? `*${search}*`
        : search
}
