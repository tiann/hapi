import React from 'react'
import { sanitizeTelemetryText, telemetryFingerprint } from '@hapi/protocol/telemetry'
import { captureEvent } from './queue'

/**
 * Root ErrorBoundary (design §4.2 render_error + 顺修全仓零 ErrorBoundary 的
 * 白屏债). Wraps RouterProvider in main.tsx. The fallback UI uses inline
 * styles only — the error may well have broken the stylesheet pipeline.
 *
 * boundary 自身错误吞掉 + console.error(§7.2 风险 2):getDerivedStateFromError
 * 渲染回退 UI 期间再抛错由 React 卸载树,componentDidCatch 自身 fail-silent。
 */

interface Props {
    children: React.ReactNode
}

interface State {
    error: Error | null
}

const shellStyle: React.CSSProperties = {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '16px',
    padding: '24px',
    fontFamily: 'system-ui, sans-serif',
    background: '#111214',
    color: '#e6e6e6',
}

export class TelemetryErrorBoundary extends React.Component<Props, State> {
    state: State = { error: null }

    static getDerivedStateFromError(error: Error): State {
        return { error }
    }

    componentDidCatch(error: Error, info: React.ErrorInfo): void {
        try {
            const messageHead = sanitizeTelemetryText(error.message)
            captureEvent(
                'diag',
                'render_error',
                {
                    boundary: 'root',
                    fatal: true,
                    ...(error.name ? { name: error.name.slice(0, 128) } : {}),
                    ...(messageHead ? { messageHead } : {}),
                    ...(typeof info.componentStack === 'string' && info.componentStack
                        ? {
                            componentStackTop: sanitizeTelemetryText(
                                info.componentStack.split('\n').filter((line) => line.trim().length > 0).slice(0, 3).join(' | '),
                                200
                            ),
                        }
                        : {}),
                },
                { severity: 'error', fingerprint: telemetryFingerprint(error.name || 'render', messageHead) }
            )
        } catch {
            // fail-silent — never let telemetry break error handling
        }
        try {
            console.error('[telemetry] render_error captured by root boundary', error)
        } catch {
            // console unavailable
        }
    }

    render(): React.ReactNode {
        const { error } = this.state
        if (error === null) return this.props.children
        const summary = `${error.name || 'Error'}: ${sanitizeTelemetryText(error.message, 160)}`
        return (
            <div style={shellStyle}>
                <div style={{ fontSize: '18px', fontWeight: 600 }}>Page rendering error</div>
                <div style={{ maxWidth: '560px', fontSize: '13px', opacity: 0.7, wordBreak: 'break-word', textAlign: 'center' }}>
                    {summary}
                </div>
                <button
                    type="button"
                    onClick={() => {
                        try {
                            window.location.reload()
                        } catch {
                            // fail-silent
                        }
                    }}
                    style={{
                        padding: '8px 20px',
                        fontSize: '14px',
                        borderRadius: '8px',
                        border: '1px solid rgba(128,128,128,0.4)',
                        background: 'rgba(128,128,128,0.15)',
                        color: 'inherit',
                        cursor: 'pointer',
                    }}
                >
                    Reload
                </button>
            </div>
        )
    }
}
