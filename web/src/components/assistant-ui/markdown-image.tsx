import { useEffect, useState, type ComponentPropsWithoutRef } from 'react'
import { useOptionalHappyChatContext } from '@/components/AssistantChat/context'
import { ImagePreview } from '@/components/ImagePreview'
import { cn } from '@/lib/utils'
import {
    getMarkdownImageMimeType,
    MAX_MARKDOWN_IMAGE_BYTES,
    resolveMarkdownFileImage,
    type MarkdownAssetTarget,
} from '@/lib/markdown-file-assets'

type ChatMarkdownImageTarget = Extract<MarkdownAssetTarget, { kind: 'local' | 'remote' | 'inert' }>

type MarkdownImageState = {
    key: string
    dataUrl: string | null
    fileSize?: number
    failed: boolean
    loaded: boolean
}

function resolveChatMarkdownImage(src: string, workspacePath: string | null | undefined): ChatMarkdownImageTarget {
    const target = resolveMarkdownFileImage('.hapi-chat-message.md', src, { workspacePath })
    if (target.kind === 'local' || target.kind === 'remote') return target
    return { kind: 'inert', href: src }
}

function markdownImageFallback(props: { label?: string; source: string; className?: string }) {
    return (
        <span
            role="img"
            aria-label={props.label || 'Image unavailable'}
            title={props.source}
            data-hapi-markdown-image-fallback="true"
            className={cn('aui-md-img-fallback my-3 text-[var(--app-hint)]', props.className)}
        >
            {props.label || 'Image unavailable'}
        </span>
    )
}

function markdownImageLoading(props: { label?: string; className?: string }) {
    return (
        <span
            role="img"
            aria-label={props.label || 'Loading image'}
            data-hapi-markdown-image-loading="true"
            className={cn('aui-md-img-loading my-3 text-[var(--app-hint)]', props.className)}
        >
            {props.label || 'Loading image'}
        </span>
    )
}

function markdownImageFileName(source: ChatMarkdownImageTarget, src: string, alt?: string): string {
    const candidate = source.kind === 'local'
        ? source.path
        : source.kind === 'remote'
            ? source.href
            : src
    const withoutMeta = candidate.split(/[?#]/, 1)[0] ?? candidate
    const normalized = withoutMeta.replaceAll('\\', '/')
    const basename = normalized.slice(normalized.lastIndexOf('/') + 1)
    try {
        return decodeURIComponent(basename) || alt?.trim() || 'Image'
    } catch {
        return basename || alt?.trim() || 'Image'
    }
}

export function ChatMarkdownImage(props: ComponentPropsWithoutRef<'img'>) {
    const { src, alt, onLoad, onError, className, ...imageProps } = props
    const chat = useOptionalHappyChatContext()
    const workspacePath = chat?.metadata?.path ?? null
    const source = typeof src === 'string'
        ? resolveChatMarkdownImage(src, workspacePath)
        : { kind: 'inert', href: '' } as const
    const localPath = source.kind === 'local' ? source.path : null
    const sourceKey = source.kind === 'local' ? source.path : source.href
    const api = chat?.api
    const sessionId = chat?.sessionId
    const [state, setState] = useState<MarkdownImageState>(() => ({
        key: sourceKey,
        dataUrl: null,
        failed: source.kind === 'inert' || (source.kind === 'local' && (!api || !sessionId)),
        loaded: false,
    }))

    useEffect(() => {
        let active = true
        if (!localPath || !api || !sessionId) {
            setState({ key: sourceKey, dataUrl: null, failed: source.kind !== 'remote', loaded: false })
            return () => {
                active = false
            }
        }

        setState({ key: sourceKey, dataUrl: null, failed: false, loaded: false })
        void api.readSessionFile(sessionId, localPath, MAX_MARKDOWN_IMAGE_BYTES).then((result) => {
            if (!active) return
            const mimeType = getMarkdownImageMimeType(localPath)
            const tooLarge = result.size !== undefined && result.size > MAX_MARKDOWN_IMAGE_BYTES
            if (!result.success || !result.content || !mimeType || tooLarge) {
                setState({ key: sourceKey, dataUrl: null, failed: true, loaded: false })
                return
            }
            setState({
                key: sourceKey,
                dataUrl: `data:${mimeType};base64,${result.content}`,
                fileSize: result.size,
                failed: false,
                loaded: false,
            })
        }).catch(() => {
            if (active) setState({ key: sourceKey, dataUrl: null, failed: true, loaded: false })
        })

        return () => {
            active = false
        }
    }, [api, localPath, sessionId, source.kind, sourceKey, workspacePath])

    if (localPath && state.key === sourceKey && !state.failed && !state.dataUrl) {
        return markdownImageLoading({ label: alt, className })
    }

    if (state.key !== sourceKey || state.failed) {
        return markdownImageFallback({ label: alt, source: typeof src === 'string' ? src : '', className })
    }

    const resolvedSrc = localPath ? state.dataUrl : source.kind === 'remote' ? source.href : null
    if (!resolvedSrc) {
        return markdownImageFallback({ label: alt, source: typeof src === 'string' ? src : '', className })
    }

    const fileName = markdownImageFileName(source, typeof src === 'string' ? src : '', alt)
    const label = alt?.trim() || fileName

    return (
        <ImagePreview
            src={resolvedSrc}
            fileName={fileName}
            label={label}
            fileSize={state.fileSize}
            galleryId="chat-markdown-images"
            disabled={!state.loaded}
            loading="lazy"
            referrerPolicy="no-referrer"
            thumbnailProps={imageProps}
            imageStyle={imageProps.style}
            buttonClassName="my-3 inline-block max-w-full cursor-zoom-in rounded-xl text-left disabled:cursor-default"
            imageClassName={cn('aui-md-img block max-w-full rounded-xl', className)}
            onThumbnailLoad={(event) => {
                onLoad?.(event)
                setState((current) => current.key === sourceKey
                    ? { ...current, loaded: true }
                    : current)
            }}
            onThumbnailError={(event) => {
                onError?.(event)
                setState({ key: sourceKey, dataUrl: null, failed: true, loaded: false })
            }}
        />
    )
}
