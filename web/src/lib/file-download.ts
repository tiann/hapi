export function downloadBase64File(fileName: string, base64Content: string, mimeType?: string | null): void {
    const byteChars = atob(base64Content)
    const bytes = new Uint8Array(byteChars.length)
    for (let index = 0; index < byteChars.length; index += 1) {
        bytes[index] = byteChars.charCodeAt(index)
    }

    const url = URL.createObjectURL(new Blob([bytes], { type: mimeType ?? 'application/octet-stream' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
}
