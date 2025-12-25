import { useCallback, useEffect, useState } from 'react'
import { ApiClient } from '@/api/client'
import { Spinner } from '@/components/Spinner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import type { ServerUrlResult } from '@/hooks/useServerUrl'

type LoginPromptProps = {
    onLogin: (token: string) => void
    baseUrl: string
    serverUrl: string | null
    setServerUrl: (input: string) => ServerUrlResult
    clearServerUrl: () => void
    error?: string | null
}

export function LoginPrompt(props: LoginPromptProps) {
    const [accessToken, setAccessToken] = useState('')
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [isServerDialogOpen, setIsServerDialogOpen] = useState(false)
    const [serverInput, setServerInput] = useState(props.serverUrl ?? '')
    const [serverError, setServerError] = useState<string | null>(null)

    const handleSubmit = useCallback(async (e: React.FormEvent) => {
        e.preventDefault()

        const trimmedToken = accessToken.trim()
        if (!trimmedToken) {
            setError('Please enter an access token')
            return
        }

        setIsLoading(true)
        setError(null)

        try {
            // Validate the token by attempting to authenticate
            const client = new ApiClient('', { baseUrl: props.baseUrl })
            await client.authenticate({ accessToken: trimmedToken })
            // If successful, pass the token to parent
            props.onLogin(trimmedToken)
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Authentication failed')
        } finally {
            setIsLoading(false)
        }
    }, [accessToken, props])

    useEffect(() => {
        if (!isServerDialogOpen) {
            return
        }
        setServerInput(props.serverUrl ?? '')
        setServerError(null)
    }, [isServerDialogOpen, props.serverUrl])

    const handleSaveServer = useCallback((e: React.FormEvent) => {
        e.preventDefault()
        const result = props.setServerUrl(serverInput)
        if (!result.ok) {
            setServerError(result.error)
            return
        }
        setServerError(null)
        setServerInput(result.value)
        setIsServerDialogOpen(false)
    }, [props, serverInput])

    const handleClearServer = useCallback(() => {
        props.clearServerUrl()
        setServerInput('')
        setServerError(null)
        setIsServerDialogOpen(false)
    }, [props])

    const displayError = error || props.error
    const serverSummary = props.serverUrl ?? `${props.baseUrl} (same origin)`

    return (
        <div className="relative h-full flex items-center justify-center p-4">
            <div className="absolute right-4 top-4 z-10">
                <Dialog open={isServerDialogOpen} onOpenChange={setIsServerDialogOpen}>
                    <DialogTrigger asChild>
                        <Button variant="outline" size="sm" className="gap-2">
                            Server
                            <span className="text-[10px] uppercase tracking-wide text-[var(--app-hint)]">
                                {props.serverUrl ? 'Custom' : 'Default'}
                            </span>
                        </Button>
                    </DialogTrigger>
                    <DialogContent className="max-w-md">
                        <DialogHeader>
                            <DialogTitle>Server URL</DialogTitle>
                            <DialogDescription>
                                Set the hapi server origin for API and live updates.
                            </DialogDescription>
                        </DialogHeader>
                        <form onSubmit={handleSaveServer} className="space-y-4">
                            <div className="text-xs text-[var(--app-hint)]">
                                Current: {serverSummary}
                            </div>
                            <div className="space-y-2">
                                <label className="text-xs font-medium">Server origin</label>
                                <input
                                    type="url"
                                    value={serverInput}
                                    onChange={(e) => {
                                        setServerInput(e.target.value)
                                        setServerError(null)
                                    }}
                                    placeholder="https://hapi.example.com"
                                    className="w-full px-3 py-2.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-2 focus:ring-[var(--app-button)] focus:border-transparent"
                                />
                                <div className="text-[11px] text-[var(--app-hint)]">
                                    Use http(s) only. Any path is ignored.
                                </div>
                            </div>

                            {serverError && (
                                <div className="text-sm text-red-500">
                                    {serverError}
                                </div>
                            )}

                            <div className="flex items-center justify-end gap-2">
                                {props.serverUrl && (
                                    <Button type="button" variant="outline" onClick={handleClearServer}>
                                        Use same origin
                                    </Button>
                                )}
                                <Button type="submit">
                                    Save server
                                </Button>
                            </div>
                        </form>
                    </DialogContent>
                </Dialog>
            </div>
            <div className="w-full max-w-sm space-y-6">
                {/* Header */}
                <div className="text-center space-y-2">
                    <div className="text-2xl font-semibold">Hapi</div>
                    <div className="text-sm text-[var(--app-hint)]">
                        Enter your access token to continue
                    </div>
                </div>

                {/* Form */}
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                        <input
                            type="password"
                            value={accessToken}
                            onChange={(e) => setAccessToken(e.target.value)}
                            placeholder="Access Token"
                            autoComplete="current-password"
                            disabled={isLoading}
                            className="w-full px-3 py-2.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-2 focus:ring-[var(--app-button)] focus:border-transparent disabled:opacity-50"
                        />
                    </div>

                    {displayError && (
                        <div className="text-sm text-red-500 text-center">
                            {displayError}
                        </div>
                    )}

                    <button
                        type="submit"
                        disabled={isLoading || !accessToken.trim()}
                        aria-busy={isLoading}
                        className="w-full py-2.5 rounded-lg bg-[var(--app-button)] text-[var(--app-button-text)] font-medium disabled:opacity-50 hover:opacity-90 transition-opacity inline-flex items-center justify-center gap-2"
                    >
                        {isLoading ? (
                            <>
                                <Spinner size="sm" label={null} className="text-[var(--app-button-text)]" />
                                Signing in…
                            </>
                        ) : (
                            'Sign In'
                        )}
                    </button>
                </form>

                {/* Help text */}
                <div className="text-xs text-[var(--app-hint)] text-center">
                    Use the CLI_API_TOKEN from your server configuration
                </div>
            </div>
        </div>
    )
}
