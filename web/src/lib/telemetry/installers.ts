import { sanitizeTelemetryText, telemetryFingerprint } from '@hapi/protocol/telemetry'
import { captureEvent, drainPendingHttpObservations, flushPageHideNow, flushQueue } from './queue'
import { state } from './state'

/**
 * Global installers: the diag three-layer error capture (window error →
 * js_error, unhandledrejection → promise_rejection; the third layer is the
 * root ErrorBoundary component) plus the immediate-flush lifecycle listeners
 * (visibilitychange→hidden / pagehide / online). All fail-silent.
 */

function parseStackTop(stack: unknown): string[] | undefined {
    try {
        if (typeof stack !== 'string' || !stack) return undefined
        const frames = stack
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.startsWith('at ') || line.includes('@'))
            .slice(0, 3)
            .map((line) => sanitizeTelemetryText(line, 200))
            .filter((line) => line.length > 0)
        return frames.length > 0 ? frames : undefined
    } catch {
        return undefined
    }
}

function describeError(error: unknown, fallbackMessage: string): { name: string; messageHead: string } {
    try {
        if (error instanceof Error) {
            return {
                name: error.name.slice(0, 128) || 'Error',
                messageHead: sanitizeTelemetryText(error.message || fallbackMessage),
            }
        }
        const text = typeof error === 'string' ? error : fallbackMessage
        return { name: 'Error', messageHead: sanitizeTelemetryText(text) }
    } catch {
        return { name: 'Error', messageHead: '' }
    }
}

function onWindowError(event: ErrorEvent): void {
    try {
        const described = describeError(event.error, typeof event.message === 'string' ? event.message : '')
        const stackTop = parseStackTop(event.error instanceof Error ? event.error.stack : undefined)
        captureEvent(
            'diag',
            'js_error',
            {
                name: described.name,
                messageHead: described.messageHead,
                // Red line: the URL query is dropped wholesale (never stored,
                // even for a static asset path) — event.filename carries
                // whatever query the failing script URL had.
                ...(typeof event.filename === 'string' && event.filename
                    ? { source: event.filename.split('?')[0]!.slice(0, 256) }
                    : {}),
                ...(typeof event.lineno === 'number' && event.lineno > 0 ? { line: event.lineno } : {}),
                ...(typeof event.colno === 'number' && event.colno > 0 ? { col: event.colno } : {}),
                ...(stackTop ? { stackTop } : {}),
            },
            {
                severity: 'error',
                fingerprint: telemetryFingerprint(described.name, described.messageHead),
            }
        )
    } catch {
        // fail-silent
    }
}

function onUnhandledRejection(event: PromiseRejectionEvent): void {
    try {
        const reason: unknown = event.reason
        const described = describeError(reason, 'unhandled rejection')
        captureEvent(
            'diag',
            'promise_rejection',
            {
                name: described.name,
                messageHead: described.messageHead,
            },
            {
                severity: 'error',
                fingerprint: telemetryFingerprint(described.name, described.messageHead),
            }
        )
    } catch {
        // fail-silent
    }
}

function onVisibilityChange(): void {
    try {
        if (document.hidden) {
            drainPendingHttpObservations()
            void flushQueue('hidden')
        }
    } catch {
        // fail-silent
    }
}

function onPageHide(): void {
    try {
        flushPageHideNow()
    } catch {
        // fail-silent
    }
}

function onOnline(): void {
    try {
        void flushQueue('online')
    } catch {
        // fail-silent
    }
}

export function installGlobalHandlers(): void {
    try {
        if (state.handlersInstalled) return
        window.addEventListener('error', onWindowError)
        window.addEventListener('unhandledrejection', onUnhandledRejection)
        document.addEventListener('visibilitychange', onVisibilityChange)
        window.addEventListener('pagehide', onPageHide)
        window.addEventListener('online', onOnline)
        state.handlersInstalled = true
    } catch {
        // fail-silent
    }
}

export function uninstallGlobalHandlers(): void {
    try {
        window.removeEventListener('error', onWindowError)
        window.removeEventListener('unhandledrejection', onUnhandledRejection)
        document.removeEventListener('visibilitychange', onVisibilityChange)
        window.removeEventListener('pagehide', onPageHide)
        window.removeEventListener('online', onOnline)
        state.handlersInstalled = false
    } catch {
        // fail-silent
    }
}
