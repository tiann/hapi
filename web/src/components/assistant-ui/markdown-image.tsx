import { useEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react'
import type { FileReadFailureReason } from '@hapi/protocol/apiTypes'
import { useOptionalHappyChatContext } from '@/components/AssistantChat/context'
import { ImagePreview } from '@/components/ImagePreview'
import { formatFileSize } from '@/lib/file-metadata'
import { useTranslation } from '@/lib/use-translation'
import { cn } from '@/lib/utils'
import {
    getMarkdownImageMimeType,
    MAX_MARKDOWN_IMAGE_BYTES,
    resolveMarkdownFileImage,
    type MarkdownAssetTarget,
} from '@/lib/markdown-file-assets'

type ChatMarkdownImageTarget = Extract<MarkdownAssetTarget, { kind: 'local' | 'remote' | 'inert' }>

type MarkdownImageFailureReason =
    | FileReadFailureReason
    | 'unsupported-format'
    | 'decode-failed'
    | 'remote-load-failed'
    | 'invalid-source'

type MarkdownImageState = {
    key: string
    attempt: number
    dataUrl: string | null
    fileSize?: number
    failure?: MarkdownImageFailureReason
    loaded: boolean
    retrying: boolean
}

const FILE_READ_FAILURE_REASONS = new Set<FileReadFailureReason>([
    'not-found',
    'too-large',
    'not-regular-file',
    'file-changed',
    'access-denied',
    'outside-workspace',
    'session-unavailable',
    'read-failed',
])

function normalizeFileReadFailureReason(reason: FileReadFailureReason | undefined): FileReadFailureReason {
    return reason && FILE_READ_FAILURE_REASONS.has(reason) ? reason : 'read-failed'
}

function resolveChatMarkdownImage(src: string, workspacePath: string | null | undefined): ChatMarkdownImageTarget {
    const target = resolveMarkdownFileImage('.hapi-chat-message.md', src, { workspacePath })
    if (target.kind === 'local' || target.kind === 'remote') return target
    return { kind: 'inert', href: src, reason: target.kind === 'inert' ? target.reason ?? 'blocked' : 'blocked' }
}

function isRetryableFailure(reason: MarkdownImageFailureReason): boolean {
    return reason !== 'invalid-source' && reason !== 'outside-workspace' && reason !== 'unsupported-format'
}

function failureMessageKey(reason: MarkdownImageFailureReason): string {
    switch (reason) {
        case 'not-found': return 'markdownImage.failure.notFound'
        case 'too-large': return 'markdownImage.failure.tooLarge'
        case 'not-regular-file': return 'markdownImage.failure.notRegularFile'
        case 'file-changed': return 'markdownImage.failure.fileChanged'
        case 'access-denied': return 'markdownImage.failure.accessDenied'
        case 'outside-workspace':
        case 'invalid-source': return 'markdownImage.failure.pathNotAllowed'
        case 'session-unavailable': return 'markdownImage.failure.sessionUnavailable'
        case 'unsupported-format': return 'markdownImage.failure.unsupportedFormat'
        case 'decode-failed': return 'markdownImage.failure.decodeFailed'
        case 'remote-load-failed': return 'markdownImage.failure.remoteLoadFailed'
        case 'read-failed': return 'markdownImage.failure.readFailed'
    }
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

function MarkdownImageLoading(props: { label: string; retrying: boolean; placeholder?: boolean }) {
    const { t } = useTranslation()
    const text = props.retrying ? t('markdownImage.retrying') : t('markdownImage.loading')
    if (props.placeholder) {
        return (
            <div
                role="status"
                aria-live="polite"
                aria-label={`${props.label}: ${text}`}
                data-hapi-markdown-image-loading="true"
                data-hapi-markdown-image-retrying={props.retrying ? 'true' : undefined}
                className="aui-md-img-loading my-3 flex min-h-44 items-center justify-center rounded-xl border border-dashed border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-4 py-5 text-center text-sm text-[var(--app-hint)]"
            >
                {text}
            </div>
        )
    }
    return (
        <span
            role="status"
            aria-live="polite"
            aria-label={`${props.label}: ${text}`}
            data-hapi-markdown-image-loading="true"
            data-hapi-markdown-image-retrying={props.retrying ? 'true' : undefined}
            className="aui-md-img-loading my-3 block text-sm text-[var(--app-hint)]"
        >
            {text}
        </span>
    )
}
function MarkdownImageFailure(props: {
    label: string
    fileName: string
    reason: MarkdownImageFailureReason
    fileSize?: number
    onRetry?: () => void
}) {
    const { t } = useTranslation()
    const size = formatFileSize(props.fileSize)
    const limit = formatFileSize(MAX_MARKDOWN_IMAGE_BYTES) ?? '10 MB'
    const message = props.reason === 'too-large'
        ? t(size ? 'markdownImage.failure.tooLargeWithSize' : 'markdownImage.failure.tooLargeLimit', { size: size ?? '', limit })
        : t(failureMessageKey(props.reason))

    if (props.onRetry) {
        return (
            <div
                role="group"
                aria-label={props.label}
                title={props.fileName}
                data-hapi-markdown-image-fallback="true"
                data-hapi-markdown-image-failure={props.reason}
                data-hapi-markdown-image-failure-layout="placeholder"
                className="aui-md-img-fallback my-3 flex min-h-44 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-4 py-5 text-center text-sm text-[var(--app-hint)]"
            >
                <span
                    aria-hidden="true"
                    className="grid h-10 w-10 place-items-center rounded-xl bg-[var(--app-secondary-bg)] text-base font-medium text-[var(--app-hint)]"
                >
                    !
                </span>
                <span className="font-medium text-[var(--app-fg)]">{t('markdownImage.unavailable')}</span>
                <span className="max-w-full break-words text-xs font-medium text-[var(--app-fg)]">{props.label}</span>
                <span role="status" aria-live="polite" className="max-w-md text-xs">{message}</span>
                <button
                    type="button"
                    onClick={props.onRetry}
                    aria-label={t('markdownImage.retryImage', { fileName: props.label })}
                    data-hapi-markdown-image-retry="true"
                    className="mt-1 inline-flex min-h-11 items-center justify-center rounded-lg bg-[var(--app-button)] px-4 text-xs font-medium text-[var(--app-button-text)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--app-bg)]"
                >
                    {t('button.retry')}
                </button>
            </div>
        )
    }

    return (
        <div
            role="group"
            aria-label={props.label}
            title={props.fileName}
            data-hapi-markdown-image-fallback="true"
            data-hapi-markdown-image-failure={props.reason}
            data-hapi-markdown-image-failure-layout="compact"
            className="aui-md-img-fallback my-3 flex items-center gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2 text-sm text-[var(--app-hint)]"
        >
            <span
                aria-hidden="true"
                className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[var(--app-secondary-bg)] text-xs font-medium text-[var(--app-hint)]"
            >
                !
            </span>
            <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-[var(--app-fg)]">{props.label}</span>
                <span role="status" aria-live="polite" className="block text-xs">{message}</span>
            </span>
        </div>
    )
}
export function ChatMarkdownImage(props: ComponentPropsWithoutRef<'img'>) {
    const { src, alt, onLoad, onError, className, ...imageProps } = props
    const { t } = useTranslation()
    const chat = useOptionalHappyChatContext()
    const workspacePath = chat?.metadata?.path ?? null
    const source: ChatMarkdownImageTarget = typeof src === 'string'
        ? resolveChatMarkdownImage(src, workspacePath)
        : { kind: 'inert', href: '', reason: 'blocked' }
    const localPath = source.kind === 'local' ? source.path : null
    const mimeType = localPath ? getMarkdownImageMimeType(localPath) : null
    const sourceKey = source.kind === 'local' ? source.path : source.href
    const api = chat?.api
    const sessionId = chat?.sessionId
    const fileName = markdownImageFileName(source, typeof src === 'string' ? src : '', alt)
    const label = alt?.trim() || fileName
    const intrinsicFailure: MarkdownImageFailureReason | undefined = source.kind === 'inert'
        ? source.reason === 'unsupported-image' ? 'unsupported-format' : 'invalid-source'
        : source.kind === 'local' && (!api || !sessionId)
            ? 'session-unavailable'
            : source.kind === 'local' && !mimeType
                ? 'unsupported-format'
                : undefined
    const [attemptState, setAttemptState] = useState({ key: sourceKey, value: 0 })
    const retryInFlightRef = useRef(false)
    const attempt = attemptState.key === sourceKey ? attemptState.value : 0
    const [state, setState] = useState<MarkdownImageState>(() => ({
        key: sourceKey,
        attempt: 0,
        dataUrl: null,
        failure: intrinsicFailure,
        loaded: false,
        retrying: false,
    }))

    useEffect(() => {
        let active = true
        retryInFlightRef.current = false

        if (source.kind === 'remote') {
            setState({
                key: sourceKey,
                attempt,
                dataUrl: null,
                failure: undefined,
                loaded: false,
                retrying: attempt > 0,
            })
            return () => {
                active = false
            }
        }

        if (!localPath || !api || !sessionId) {
            setState({
                key: sourceKey,
                attempt,
                dataUrl: null,
                failure: source.kind === 'inert' ? 'invalid-source' : 'session-unavailable',
                loaded: false,
                retrying: false,
            })
            return () => {
                active = false
            }
        }

        if (!mimeType) {
            setState({
                key: sourceKey,
                attempt,
                dataUrl: null,
                failure: 'unsupported-format',
                loaded: false,
                retrying: false,
            })
            return () => {
                active = false
            }
        }

        setState({
            key: sourceKey,
            attempt,
            dataUrl: null,
            failure: undefined,
            loaded: false,
            retrying: attempt > 0,
        })
        void api.readSessionFile(sessionId, localPath, MAX_MARKDOWN_IMAGE_BYTES).then((result) => {
            if (!active) return
            const tooLarge = result.size !== undefined && result.size > MAX_MARKDOWN_IMAGE_BYTES
            if (tooLarge) {
                setState({
                    key: sourceKey,
                    attempt,
                    dataUrl: null,
                    fileSize: result.size,
                    failure: 'too-large',
                    loaded: false,
                    retrying: false,
                })
                return
            }
            if (!result.success || !result.content) {
                setState({
                    key: sourceKey,
                    attempt,
                    dataUrl: null,
                    fileSize: result.size,
                    failure: normalizeFileReadFailureReason(result.reason),
                    loaded: false,
                    retrying: false,
                })
                return
            }
            setState({
                key: sourceKey,
                attempt,
                dataUrl: `data:${mimeType};base64,${result.content}`,
                fileSize: result.size,
                failure: undefined,
                loaded: false,
                retrying: attempt > 0,
            })
        }).catch(() => {
            if (!active) return
            setState({
                key: sourceKey,
                attempt,
                dataUrl: null,
                failure: 'session-unavailable',
                loaded: false,
                retrying: false,
            })
        })

        return () => {
            active = false
        }
    }, [api, attempt, localPath, mimeType, sessionId, source.kind, sourceKey])

    const retryImage = () => {
        if (!state.failure || !isRetryableFailure(state.failure) || retryInFlightRef.current) return
        retryInFlightRef.current = true
        const nextAttempt = attempt + 1
        setState({
            key: sourceKey,
            attempt: nextAttempt,
            dataUrl: null,
            failure: undefined,
            loaded: false,
            retrying: true,
        })
        setAttemptState({ key: sourceKey, value: nextAttempt })
    }

    if (intrinsicFailure) {
        return (
            <MarkdownImageFailure
                label={label}
                fileName={fileName}
                reason={intrinsicFailure}
                onRetry={isRetryableFailure(intrinsicFailure) ? retryImage : undefined}
            />
        )
    }

    if (state.key !== sourceKey) {
        return <MarkdownImageLoading label={label} retrying={false} />
    }

    if (state.failure) {
        return (
            <MarkdownImageFailure
                label={label}
                fileName={fileName}
                reason={state.failure}
                fileSize={state.fileSize}
                onRetry={isRetryableFailure(state.failure) ? retryImage : undefined}
            />
        )
    }

    if (localPath && !state.dataUrl) {
        return <MarkdownImageLoading label={label} retrying={state.retrying} placeholder={state.retrying} />
    }

    const resolvedSrc = localPath ? state.dataUrl : source.kind === 'remote' ? source.href : null
    if (!resolvedSrc) {
        return (
            <MarkdownImageFailure
                label={label}
                fileName={fileName}
                reason="read-failed"
                onRetry={retryImage}
            />
        )
    }

    return (
        <ImagePreview
            key={`${sourceKey}:${attempt}`}
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
            buttonClassName={cn(
                'my-3 max-w-full cursor-zoom-in rounded-xl text-left disabled:cursor-default',
                state.retrying && !state.loaded
                    ? 'flex min-h-44 items-center justify-center border border-dashed border-[var(--app-border)] bg-[var(--app-subtle-bg)]'
                    : 'inline-block',
            )}
            imageClassName={cn(
                'aui-md-img block max-w-full rounded-xl',
                state.retrying && !state.loaded && 'opacity-0',
                className,
            )}
            caption={state.retrying && !state.loaded ? (
                <span role="status" aria-live="polite" className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-sm text-[var(--app-hint)]">
                    {t('markdownImage.retrying')}
                </span>
            ) : undefined}
            onThumbnailLoad={(event) => {
                onLoad?.(event)
                setState((current) => current.key === sourceKey && current.attempt === attempt
                    ? { ...current, loaded: true, retrying: false }
                    : current)
            }}
            onThumbnailError={(event) => {
                onError?.(event)
                setState((current) => current.key === sourceKey && current.attempt === attempt
                    ? {
                        ...current,
                        dataUrl: null,
                        failure: source.kind === 'remote' ? 'remote-load-failed' : 'decode-failed',
                        loaded: false,
                        retrying: false,
                    }
                    : current)
            }}
        />
    )
}