import { useCallback, useState } from 'react'
import { ApiClient } from '@/api/client'

type LoginPromptProps = {
    onLogin: (token: string) => void
    error?: string | null
}

export function LoginPrompt(props: LoginPromptProps) {
    const [accessToken, setAccessToken] = useState('')
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

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
            const client = new ApiClient('')
            await client.authenticate({ accessToken: trimmedToken })
            // If successful, pass the token to parent
            props.onLogin(trimmedToken)
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Authentication failed')
        } finally {
            setIsLoading(false)
        }
    }, [accessToken, props])

    const displayError = error || props.error

    return (
        <div className="h-full flex items-center justify-center p-4">
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
                        className="w-full py-2.5 rounded-lg bg-[var(--app-button)] text-[var(--app-button-text)] font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
                    >
                        {isLoading ? 'Signing in...' : 'Sign In'}
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
