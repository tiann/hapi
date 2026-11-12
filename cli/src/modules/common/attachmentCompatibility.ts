import { realpathSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { detectDisplayMediaMimeType, detectImageMimeType, getGeneratedImage, MAX_GENERATED_IMAGE_BYTES, readBoundedRegularFile, registerGeneratedImage } from './generatedImages'

/**
 * Determine if a permission mode permits autonomous/auto-approved execution.
 * Only explicit full-autonomy modes (yolo, bypassPermissions, always-proceed)
 * are authorized to read workspace attachments automatically.
 */
export function isAutoApprovedPermissionMode(mode?: string | null): boolean {
    if (!mode) return false
    return mode === 'yolo' || mode === 'bypassPermissions' || mode === 'always-proceed'
}

/**
 * Authorization gate for automatic attachment links.
 * In restrictive sessions (default, read-only, plan, ask), link-triggered
 * reads must not silently bypass user approval unless explicitly enabled
 * via environment variable.
 */
export function isAttachmentFallbackAuthorized(
    mode?: string | null,
    env: NodeJS.ProcessEnv = process.env
): boolean {
    const raw = env.HAPI_AUTO_ATTACHMENT_LINKS
    if (raw !== undefined && raw !== '') {
        const normalized = raw.trim().toLowerCase()
        if (normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes') {
            return true
        }
        if (normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no') {
            return false
        }
    }
    return isAutoApprovedPermissionMode(mode)
}

export interface AttachmentCompatibilityOptions {
    permissionMode?: string | null
    isAuthorized?: boolean
}

export type AttachmentLinkCandidate = {
    path: string
    rawTarget: string
    isMarkdownImage: boolean
}

/** Only explicit delivery links, never tool output, reasoning, or bare file citations. */
export function attachmentLinks(text: string): AttachmentLinkCandidate[] {
    const prose = text.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1[^\n]*$/gm, '')
        .replace(/(`+)[^\n]*?\1/g, '')
    const candidates: AttachmentLinkCandidate[] = []
    const seen = new Set<string>()
    const links = /(!?)\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s()]+(?:\([^()]*\)[^\s()]*)*))\s*(?:["'][^\n]*?["']\s*)?\)/g
    for (const match of prose.matchAll(links)) {
        const isMarkdownImage = match[1] === '!'
        const rawTarget = match[2] ?? match[3] ?? ''
        let target = rawTarget
        try {
            if (target.startsWith('file:')) target = fileURLToPath(target)
            else target = decodeURIComponent(target.replace(/^sandbox:/, ''))
        } catch { continue }
        if (/^[a-z][a-z\d+.-]*:/i.test(target) && !/^[A-Za-z]:[\\/]/.test(target)) continue
        if (target.startsWith('//') || /[\x00-\x1f#?]/.test(target)) continue
        // Source citations with line numbers remain ordinary links.
        if (/:\d+(?::\d+)?$/.test(target)) continue
        if (!/\.(?:pdf|docx?|xlsx?|pptx?|csv|tsv|txt|md|zip|tar|gz|png|jpe?g|gif|webp|svg|mp4|webm|mp3|wav|ogg|flac)$/i.test(target)) continue
        if (!seen.has(target)) {
            seen.add(target)
            candidates.push({ path: target, rawTarget, isMarkdownImage })
        }
        if (candidates.length === 16) break
    }
    return candidates
}

export function assistantAttachmentText(body: unknown): string | null {
    if (!body || typeof body !== 'object') return null
    const value = body as Record<string, unknown>
    if (value.live === true || value.isSidechain === true) return null
    if (value.type === 'message' && typeof value.message === 'string') return value.message
    if (value.type === 'text' && typeof value.text === 'string') return value.text
    if (value.type === 'agy_message' && typeof value.content === 'string') return value.content
    if (value.type !== 'assistant' || !value.message || typeof value.message !== 'object') return null
    const assistantMsg = value.message as Record<string, unknown>
    if (assistantMsg.isSidechain === true) return null
    const content = assistantMsg.content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return null
    return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
}

/** Per-session serial queue: bounded reads, canonical containment and duplicate suppression. */
export class AttachmentCompatibility {
    private queue = Promise.resolve()
    private seen = new Set<string>()
    private deniedPaths = new Set<string>()

    markDenied(path: string, cwd?: string): void {
        this.deniedPaths.add(path)
        const normalized = cwd && !isAbsolute(path) ? resolve(cwd, path) : (isAbsolute(path) ? resolve(path) : undefined)
        if (normalized) {
            this.deniedPaths.add(normalized)
            try {
                this.deniedPaths.add(realpathSync(normalized))
            } catch {
                // file may not exist yet
            }
        }
        // Serialize async canonicalization onto queue before subsequent enqueue runs
        this.queue = this.queue.then(async () => {
            const target = normalized ?? (cwd ? resolve(cwd, path) : undefined)
            if (target) {
                try {
                    const canonical = await realpath(target)
                    this.deniedPaths.add(canonical)
                } catch {}
            }
        }).catch(() => {})
    }

    markApproved(path: string, cwd?: string): void {
        this.deniedPaths.delete(path)
        const normalized = cwd && !isAbsolute(path) ? resolve(cwd, path) : (isAbsolute(path) ? resolve(path) : undefined)
        if (normalized) {
            this.deniedPaths.delete(normalized)
            try {
                this.deniedPaths.delete(realpathSync(normalized))
            } catch {}
        }
        this.queue = this.queue.then(async () => {
            const target = normalized ?? (cwd ? resolve(cwd, path) : undefined)
            if (target) {
                try {
                    const canonical = await realpath(target)
                    this.deniedPaths.delete(canonical)
                } catch {}
            }
        }).catch(() => {})
    }

    isDenied(path: string, canonicalPath?: string): boolean {
        return this.deniedPaths.has(path) || (canonicalPath !== undefined && this.deniedPaths.has(canonicalPath))
    }

    enqueue(
        body: unknown,
        cwd: string | undefined,
        emit: (body: unknown) => void,
        options?: AttachmentCompatibilityOptions
    ): void {
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

        // Authorization boundary: in restrictive sessions without YOLO/bypassPermissions/always-proceed,
        // link-triggered file reads must not silently bypass permission gates without user approval.
        const authorized = options?.isAuthorized ?? isAttachmentFallbackAuthorized(options?.permissionMode)
        if (!authorized) return

        const MAX_INLINE_WEB_IMAGE_BYTES = 10 * 1024 * 1024
        const SUPPORTED_INLINE_IMAGE_EXTS = /\.(?:png|jpe?g|gif|webp|svg|bmp|ico|apng|avif|tiff?)$/i
        this.queue = this.queue.then(async () => {
            const root = await realpath(cwd)
            for (const item of paths) {
                const path = item.path
                try {
                    const resolved = resolve(root, path)
                    const canonical = await realpath(resolved)
                    if (this.isDenied(path, canonical) || this.isDenied(resolved, canonical)) continue
                    const local = relative(root, canonical)
                    if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) continue
                    const info = await stat(canonical)
                    if (!info.isFile() || info.size > MAX_GENERATED_IMAGE_BYTES) continue
                    const bytes = await readBoundedRegularFile(canonical, MAX_GENERATED_IMAGE_BYTES)
                    const digest = createHash('sha256').update(bytes).digest('hex')
                    if (this.seen.has(digest)) continue
                    const media = registerGeneratedImage({ id: randomUUID(), path: canonical, bytes, mimeType: detectDisplayMediaMimeType(bytes) })
                    // ChatMarkdownImage rejects sandbox:, file:, parent-relative ('..'),
                    // non-image files, and files exceeding 10 MiB through resolveMarkdownFileImage / normalizeLocalPath.
                    // Evaluate the decoded target to catch percent-encoded parent traversals (%2e%2e).
                    let decodedTarget = item.rawTarget.trim()
                    try {
                        decodedTarget = decodeURIComponent(decodedTarget.replace(/^sandbox:/, ''))
                    } catch {}
                    decodedTarget = decodedTarget.replaceAll('\\', '/')

                    const isSupportedInlineImage =
                        SUPPORTED_INLINE_IMAGE_EXTS.test(canonical)
                        || SUPPORTED_INLINE_IMAGE_EXTS.test(decodedTarget)
                        || Boolean(detectImageMimeType(bytes))

                    const suppressWebCard =
                        item.isMarkdownImage
                        && isSupportedInlineImage
                        && !item.rawTarget.startsWith('sandbox:')
                        && !item.rawTarget.startsWith('file:')
                        && !decodedTarget.startsWith('sandbox:')
                        && !decodedTarget.startsWith('file:')
                        && !decodedTarget.startsWith('../')
                        && !decodedTarget.includes('/../')
                        && bytes.length <= MAX_INLINE_WEB_IMAGE_BYTES
                    emit({
                        type: 'generated-image',
                        imageId: media.id,
                        fileName: media.fileName,
                        mimeType: media.mimeType,
                        id: randomUUID(),
                        source: {
                            ingress: 'attachment-fallback',
                            isMarkdownImage: item.isMarkdownImage,
                            suppressWebCard,
                            linkTarget: path
                        }
                    })
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
