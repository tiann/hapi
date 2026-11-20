import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'
import { TelemetryErrorBoundary } from './ErrorBoundary'
import { queuedEventsForTest } from './queue'
import { state } from './state'
import {
    installForTest,
    resetTelemetryForTest,
    stubTelemetryFetch,
    type TelemetryFetchKit,
} from './testHelpers'

/**
 * diag 三层错误捕获的 web 半边:根 ErrorBoundary(render_error)与全局
 * window error / unhandledrejection 安装件(js_error / promise_rejection),
 * 含 messageHead 脱敏红线断言。
 */

let kit: TelemetryFetchKit

beforeEach(async () => {
    kit = stubTelemetryFetch({ level: 1 })
    installForTest(kit)
    // Let the install-time capability probe settle, then block background
    // flushes so queue assertions read a stable machine.
    await settle()
    await settle()
    state.flushing = true
})

afterEach(() => {
    kit.restore()
    resetTelemetryForTest()
})

async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
}

function diagEvents(kind: string): Array<{ data: Record<string, unknown>; fingerprint?: string; severity?: string }> {
    return queuedEventsForTest()
        .filter((e) => e.kind === kind)
        .map((e) => ({ data: e.data, fingerprint: e.fingerprint, severity: e.severity }))
}

describe('TelemetryErrorBoundary', () => {
    function Throwing(): React.ReactElement {
        throw new Error('renderer went boom')
    }

    it('renders the fallback UI and captures a render_error diag event', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
        try {
            render(
                <TelemetryErrorBoundary>
                    <Throwing />
                </TelemetryErrorBoundary>
            )
            await settle()

            expect(screen.getByText('Page rendering error')).toBeInTheDocument()
            expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
            expect(screen.getByText(/renderer went boom/)).toBeInTheDocument()

            const events = diagEvents('render_error')
            expect(events).toHaveLength(1)
            const row = events[0]!
            expect(row.data.boundary).toBe('root')
            expect(row.data.fatal).toBe(true)
            expect(row.data.name).toBe('Error')
            expect(row.data.messageHead).toContain('renderer went boom')
            expect(row.severity).toBe('error')
            expect(typeof row.fingerprint).toBe('string')
            expect(row.data.componentStackTop).toBeTruthy()
        } finally {
            spy.mockRestore()
        }
    })

    it('sanitizes credentials in the error message (脱敏红线)', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
        try {
            function ThrowingSecret(): React.ReactElement {
                throw new Error(`upload failed Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N65IiiiBSDSRWsnOVFoTQt`)
            }
            render(
                <TelemetryErrorBoundary>
                    <ThrowingSecret />
                </TelemetryErrorBoundary>
            )
            await settle()
            const events = diagEvents('render_error')
            expect(events).toHaveLength(1)
            expect(String(events[0]!.data.messageHead)).not.toContain('eyJhbGciOiJIUzI1NiJ9')
            expect(String(events[0]!.data.messageHead)).toContain('Bearer [redacted]')
        } finally {
            spy.mockRestore()
        }
    })

    it('passes children through untouched when nothing throws', () => {
        render(
            <TelemetryErrorBoundary>
                <div>all good</div>
            </TelemetryErrorBoundary>
        )
        expect(screen.getByText('all good')).toBeInTheDocument()
        expect(diagEvents('render_error')).toHaveLength(0)
    })
})

describe('window error installers', () => {
    it('js_error: window error event with full location and stack top', async () => {
        const error = new Error('ReferenceError source message')
        error.stack = 'Error: ReferenceError source message\n    at ComponentA (http://localhost/src/x.tsx:12:34)\n    at ComponentB (http://localhost/src/y.tsx:56:78)\n    at ComponentC (http://localhost/src/z.tsx:90:12)\n    at ComponentD (http://localhost/src/w.tsx:99:99)'
        window.dispatchEvent(new ErrorEvent('error', { error, message: error.message, filename: 'http://localhost/src/x.tsx', lineno: 12, colno: 34 }))
        await settle()

        const events = diagEvents('js_error')
        expect(events).toHaveLength(1)
        const row = events[0]!.data
        expect(row.name).toBe('Error')
        expect(row.messageHead).toContain('ReferenceError source message')
        expect(row.source).toBe('http://localhost/src/x.tsx')
        expect(row.line).toBe(12)
        expect(row.col).toBe(34)
        expect(row.stackTop).toEqual([
            'at ComponentA (http://localhost/src/x.tsx:12:34)',
            'at ComponentB (http://localhost/src/y.tsx:56:78)',
            'at ComponentC (http://localhost/src/z.tsx:90:12)',
        ])
        expect(events[0]!.severity).toBe('error')
    })

    it('js_error: the source URL drops its query string wholesale (red line)', async () => {
        window.dispatchEvent(new ErrorEvent('error', {
            error: new Error('chunk load failure'),
            message: 'chunk load failure',
            filename: 'https://hub.example/assets/index-B1b2C3.js?token=secret&v=2',
            lineno: 1,
            colno: 1,
        }))
        await settle()
        const events = diagEvents('js_error')
        expect(events).toHaveLength(1)
        expect(events[0]!.data.source).toBe('https://hub.example/assets/index-B1b2C3.js')
    })

    it('promise_rejection: unhandledrejection with sanitized messageHead', async () => {
        const reason = new Error('rejected with sk-abcdef123456 key')
        const event = typeof PromiseRejectionEvent === 'function'
            ? new PromiseRejectionEvent('unhandledrejection', { promise: Promise.resolve(), reason })
            : Object.assign(new Event('unhandledrejection'), { reason })
        window.dispatchEvent(event)
        await settle()

        const events = diagEvents('promise_rejection')
        expect(events).toHaveLength(1)
        expect(events[0]!.data.name).toBe('Error')
        expect(String(events[0]!.data.messageHead)).not.toContain('sk-abcdef123456')
        expect(String(events[0]!.data.messageHead)).toContain('sk-[redacted]')
    })

    it('non-Error rejections stringify safely through the sanitize net', async () => {
        const event = typeof PromiseRejectionEvent === 'function'
            ? new PromiseRejectionEvent('unhandledrejection', { promise: Promise.resolve(), reason: 'plain string reason' })
            : Object.assign(new Event('unhandledrejection'), { reason: 'plain string reason' })
        window.dispatchEvent(event)
        await settle()
        const events = diagEvents('promise_rejection')
        expect(events).toHaveLength(1)
        expect(events[0]!.data.messageHead).toBe('plain string reason')
    })

    it('capture is a no-op while the hub lacks the capability (old hub)', async () => {
        state.enabled = false
        state.level = 0
        window.dispatchEvent(new ErrorEvent('error', { error: new Error('nope'), message: 'nope' }))
        await settle()
        expect(queuedEventsForTest()).toHaveLength(0)
    })
})
