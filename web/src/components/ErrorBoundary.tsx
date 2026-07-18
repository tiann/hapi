import { Component, type ErrorInfo, type ReactNode } from 'react'

type ErrorBoundaryProps = {
    children: ReactNode
}

type ErrorBoundaryState = {
    hasError: boolean
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
    state: ErrorBoundaryState = { hasError: false }

    static getDerivedStateFromError(): ErrorBoundaryState {
        return { hasError: true }
    }

    componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
        console.error('[ErrorBoundary] Uncaught render error:', error, errorInfo)
    }

    private reload = (): void => {
        window.location.reload()
    }

    render() {
        if (this.state.hasError) {
            return (
                <div className="h-full flex items-center justify-center p-6">
                    <div className="max-w-sm space-y-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-red-950 shadow-sm">
                        <div className="text-base font-semibold">Something went wrong</div>
                        <p className="text-sm text-red-800">
                            The app UI hit an unexpected error. Reloading usually restores the live session view.
                        </p>
                        <button
                            type="button"
                            onClick={this.reload}
                            className="rounded-xl bg-red-600 px-3 py-2 text-sm font-medium text-white"
                        >
                            Reload app
                        </button>
                    </div>
                </div>
            )
        }

        return this.props.children
    }
}
