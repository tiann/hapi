export type ShareImageKind = 'turn' | 'table'

export function formatShareTimestamp(date = new Date()): string {
    const pad = (value: number) => String(value).padStart(2, '0')
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds())
    ].join('')
}

export function sanitizeShareFileNamePart(title: string): string {
    const withoutControlCharacters = Array.from(title.normalize('NFKC'))
        .filter((character) => {
            const codePoint = character.codePointAt(0) ?? 0
            return codePoint >= 32 && codePoint !== 127
        })
        .join('')
    const sanitized = withoutControlCharacters
        .replace(/[<>:"/\\|?*]+/g, '-')
        .replace(/\s+/g, ' ')
        .replace(/-+/g, '-')
        .replace(/^[ .-]+|[ .-]+$/g, '')
        .trim()
    return Array.from(sanitized || 'Shared turn').slice(0, 80).join('').trim()
}

export function getShareImageFileName(
    title: string,
    kind: ShareImageKind = 'turn',
    date = new Date(),
): string {
    const prefix = kind === 'table' ? 'HAPI Table' : 'HAPI'
    return `${prefix}-${sanitizeShareFileNamePart(title)}-${formatShareTimestamp(date)}.png`
}

export function getShareTableFileName(
    title: string,
    extension: 'png' | 'csv',
    date = new Date(),
): string {
    return getShareImageFileName(title, 'table', date).replace(/\.png$/, `.${extension}`)
}
