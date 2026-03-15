import { useCallback, useEffect, useState } from 'react'
import { ApiClient } from '@/api/client'
import { LanguageSwitcher } from '@/components/LanguageSwitcher'
import { Spinner } from '@/components/Spinner'
import { Button } from '@/shared/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/shared/ui/dialog'
import { useTranslation } from '@/lib/use-translation'
import type { ServerUrlResult } from '@/hooks/useServerUrl'

export type LoginGateProps = {
    onLogin?: (token: string) => void
    baseUrl: string
    serverUrl: string | null
    setServerUrl: (input: string) => ServerUrlResult
    clearServerUrl: () => void
    requireServerUrl?: boolean
    error?: string | null
}

export function LoginGate(props: LoginGateProps) {
    const { t } = useTranslation()
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
            setError(t('login.error.enterToken'))
            return
        }

        if (props.requireServerUrl && !props.serverUrl) {
            setServerError(t('login.server.required'))
            setIsServerDialogOpen(true)
            return
        }

        setIsLoading(true)
        setError(null)

        try {
            const client = new ApiClient('', { baseUrl: props.baseUrl })
            await client.authenticate({ accessToken: trimmedToken })
            if (!props.onLogin) {
                setError(t('login.error.loginUnavailable'))
                return
            }
            props.onLogin(trimmedToken)
        } catch (e) {
            setError(e instanceof Error ? e.message : t('login.error.authFailed'))
        } finally {
            setIsLoading(false)
        }
    }, [accessToken, props, t])

    useEffect(() => {
        if (!isServerDialogOpen) {
            return
        }
        setServerInput(props.serverUrl ?? '')
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

    const handleServerDialogOpenChange = useCallback((open: boolean) => {
        setIsServerDialogOpen(open)
        if (!open) {
            setServerError(null)
        }
    }, [])

    const displayError = error || props.error
    const serverSummary = props.serverUrl ?? `${props.baseUrl} ${t('login.server.default')}`
    const title = t('login.title')
    const subtitle = t('login.subtitle')
    const submitLabel = t('login.submit')

    return (
        <div className="relative h-full flex items-center justify-center p-4">
            <div className="absolute top-4 right-4">
                <LanguageSwitcher />
            </div>

            <div className="w-full max-w-sm space-y-6">
                <div className="text-center space-y-2">
                    <div className="text-2xl font-semibold">{title}</div>
                    <div className="text-sm text-[var(--app-hint)]">
                        {subtitle}
                    </div>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4" role="form">
                    <div>
                        <input
                            type="password"
                            value={accessToken}
                            onChange={(e) => setAccessToken(e.target.value)}
                            placeholder={t('login.placeholder')}
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
                                {t('login.submitting')}
                            </>
                        ) : (
                            submitLabel
                        )}
                    </button>
                </form>

                <div className="flex items-center justify-between text-xs text-[var(--app-hint)]">
                        <a href="https://hapi.run/docs" target="_blank" rel="noopener noreferrer" className="underline hover:text-[var(--app-fg)]">
                            {t('login.help')}
                        </a>
                        <Dialog open={isServerDialogOpen} onOpenChange={handleServerDialogOpenChange}>
                            <DialogTrigger asChild>
                                <button type="button" className="underline hover:text-[var(--app-fg)]">
                                    Hub {props.serverUrl ? `${t('login.server.custom')}` : `${t('login.server.default')}`}
                                </button>
                            </DialogTrigger>
                            <DialogContent className="max-w-md">
                                <DialogHeader>
                                    <DialogTitle>{t('login.server.title')}</DialogTitle>
                                    <DialogDescription>
                                        {t('login.server.description')}
                                    </DialogDescription>
                                </DialogHeader>
                                <form onSubmit={handleSaveServer} className="space-y-4">
                                    <div className="text-xs text-[var(--app-hint)]">
                                        {t('login.server.current')} {serverSummary}
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-xs font-medium">{t('login.server.origin')}</label>
                                        <input
                                            type="url"
                                            value={serverInput}
                                            onChange={(e) => {
                                                setServerInput(e.target.value)
                                                setServerError(null)
                                            }}
                                            placeholder={t('login.server.placeholder')}
                                            className="w-full px-3 py-2.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-2 focus:ring-[var(--app-button)] focus:border-transparent"
                                        />
                                        <div className="text-[11px] text-[var(--app-hint)]">
                                            {t('login.server.hint')}
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
                                                {t('login.server.useSameOrigin')}
                                            </Button>
                                        )}
                                        <Button type="submit">
                                            {t('login.server.save')}
                                        </Button>
                                    </div>
                                </form>
                            </DialogContent>
                        </Dialog>
                    </div>
            </div>

            <div className="absolute bottom-4 left-0 right-0 text-center text-xs text-[var(--app-hint)] space-y-1">
                <div>{t('login.footer')} <span className="text-red-500">♥</span> {t('login.footer.for')}</div>
                <div>{t('login.footer.copyright')} {new Date().getFullYear()} HAPI</div>
            </div>
        </div>
    )
}
