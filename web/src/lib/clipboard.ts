export function safeCopyToClipboard(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
        return navigator.clipboard.writeText(text)
    }
    return Promise.reject(new Error('Clipboard API not available'))
}
