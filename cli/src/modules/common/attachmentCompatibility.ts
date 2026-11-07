import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { detectDisplayMediaMimeType, getGeneratedImage, MAX_GENERATED_IMAGE_BYTES, readBoundedRegularFile, registerGeneratedImage } from './generatedImages'

/** Only explicit delivery links, never tool output, reasoning, or bare file citations. */
export function attachmentLinks(text: string): string[] {
    const prose = text.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1[^\n]*$/gm, '')
        .replace(/(`+)[^\n]*?\1/g, '')
    const paths = new Set<string>()
    const links = /!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s()]+(?:\([^()]*\)[^\s()]*)*))\s*(?:["'][^\n]*?["']\s*)?\)/g
    for (const match of prose.matchAll(links)) {
        let target = match[1] ?? match[2]
        try {
            if (target.startsWith('file:')) target = fileURLToPath(target)
            else target = decodeURIComponent(target.replace(/^sandbox:/, ''))
        } catch { continue }
        if (/^[a-z][a-z\d+.-]*:/i.test(target) && !/^[A-Za-z]:[\\/]/.test(target)) continue
        if (target.startsWith('//') || /[\x00-\x1f#?]/.test(target)) continue
        // Source citations with line numbers remain ordinary links.
        if (/:\d+(?::\d+)?$/.test(target)) continue
        if (!/\.(?:pdf|docx?|xlsx?|pptx?|csv|tsv|txt|md|zip|tar|gz|png|jpe?g|gif|webp|svg|mp4|webm|mp3|wav|ogg|flac)$/i.test(target)) continue
        paths.add(target)
        if (paths.size === 16) break
    }
    return [...paths]
}

export function assistantAttachmentText(body: unknown): string | null {
    if (!body || typeof body !== 'object') return null
    const value = body as Record<string, unknown>
    if (value.streamSnapshot === true) return null
    if (value.type === 'message' && typeof value.message === 'string') return value.message
    if (value.type === 'agy_message' && typeof value.content === 'string') return value.content
    if (value.type !== 'assistant' || !value.message || typeof value.message !== 'object') return null
    const content = (value.message as Record<string, unknown>).content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return null
    return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
}

/** Per-session serial queue: bounded reads, canonical containment and duplicate suppression. */
export class AttachmentCompatibility {
    private queue = Promise.resolve()
    private seen = new Set<string>()

    enqueue(body: unknown, cwd: string | undefined, emit: (body: unknown) => void): void {
        // A dedicated MCP/ACP upload may precede the final Markdown link.
        if (body && typeof body === 'object') {
            const value = body as Record<string, unknown>
            if (value.type === 'generated-image' && typeof value.imageId === 'string') {
                const media = getGeneratedImage(value.imageId)
                if (media) this.remember(createHash('sha256').update(media.content).digest('hex'))
                return
            }
        }
        const text = assistantAttachmentText(body)
        if (!text || !cwd) return
        const paths = attachmentLinks(text)
        if (!paths.length) return
        this.queue = this.queue.then(async () => {
            const root = await realpath(cwd)
            for (const path of paths) {
                try {
                    const canonical = await realpath(resolve(root, path))
                    const local = relative(root, canonical)
                    if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) continue
                    const info = await stat(canonical)
                    if (!info.isFile() || info.size > MAX_GENERATED_IMAGE_BYTES) continue
                    const bytes = await readBoundedRegularFile(canonical, MAX_GENERATED_IMAGE_BYTES)
                    const digest = createHash('sha256').update(bytes).digest('hex')
                    if (this.seen.has(digest)) continue
                    const media = registerGeneratedImage({ id: randomUUID(), path: canonical, bytes, mimeType: detectDisplayMediaMimeType(bytes) })
                    emit({ type: 'generated-image', imageId: media.id, fileName: media.fileName, mimeType: media.mimeType, id: randomUUID() })
                    this.remember(digest)
                } catch { /* Missing or unsupported files must not break the agent's answer. */ }
            }
        }).catch(() => {})
    }

    private remember(digest: string): void {
        this.seen.add(digest)
        if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!)
    }

    async flush(): Promise<void> { await this.queue }
}
