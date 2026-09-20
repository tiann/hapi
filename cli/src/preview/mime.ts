/**
 * Extension → MIME table for static preview mounts. Zero dependencies — the
 * hub's embedded-assets table is build-time generated and not importable from
 * the CLI. Falls back to application/octet-stream.
 */

const MIME_TYPES: Record<string, string> = {
    html: 'text/html; charset=utf-8',
    htm: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    cjs: 'text/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8',
    map: 'application/json; charset=utf-8',
    txt: 'text/plain; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
    csv: 'text/csv; charset=utf-8',
    xml: 'application/xml; charset=utf-8',
    pdf: 'application/pdf',
    wasm: 'application/wasm',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    avifs: 'image/avif',
    ico: 'image/x-icon',
    bmp: 'image/bmp',
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    opus: 'audio/opus',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    otf: 'font/otf',
    eot: 'application/vnd.ms-fontobject'
}

/** Content types that get HTML sub-path rewriting on proxy mounts. */
export function isHtmlContentType(contentType: string | undefined): boolean {
    return (contentType ?? '').toLowerCase().split(';')[0].trim() === 'text/html'
}

export function lookupMimeType(filePath: string): string {
    const base = filePath.split(/[\\/]/).pop() ?? ''
    const dot = base.lastIndexOf('.')
    if (dot <= 0) return 'application/octet-stream'
    return MIME_TYPES[base.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream'
}
