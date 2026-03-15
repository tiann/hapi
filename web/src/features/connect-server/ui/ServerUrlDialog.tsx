import { useState, useEffect, useRef } from 'react'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle
} from '@/shared/ui/dialog'
import { Button } from '@/shared/ui/button'
import { useServerUrl } from '@/hooks/useServerUrl'
import { useTranslation } from '@/lib/use-translation'

type ServerUrlDialogProps = {
    isOpen: boolean
    onClose: () => void
}

export function ServerUrlDialog(props: ServerUrlDialogProps) {
    const { t } = useTranslation()
    const { isOpen, onClose } = props
    const { serverUrl, setServerUrl, clearServerUrl } = useServerUrl()
    const [input, setInput] = useState(serverUrl ?? '')
    const [error, setError] = useState<string | null>(null)
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        if (isOpen) {
            setInput(serverUrl ?? '')
            setError(null)
            setTimeout(() => {
                inputRef.current?.focus()
            }, 100)
        }
    }, [isOpen, serverUrl])

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setError(null)

        const result = setServerUrl(input)
        if (!result.ok) {
            setError(result.error)
            return
        }

        onClose()
    }

    const handleClear = () => {
        clearServerUrl()
        setInput('')
        onClose()
    }

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            onClose()
        }
    }

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{t('settings.serverUrl.title')}</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-4">
                    <input
                        ref={inputRef}
                        type="text"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="https://example.com"
                        className="w-full px-3 py-2.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-2 focus:ring-[var(--app-button)] focus:border-transparent font-mono text-sm"
                    />

                    {error ? (
                        <div className="rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
                            {error}
                        </div>
                    ) : null}

                    <div className="flex gap-2 justify-between">
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={handleClear}
                        >
                            {t('button.clear')}
                        </Button>
                        <div className="flex gap-2">
                            <Button
                                type="button"
                                variant="secondary"
                                onClick={onClose}
                            >
                                {t('button.cancel')}
                            </Button>
                            <Button
                                type="submit"
                            >
                                {t('button.save')}
                            </Button>
                        </div>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    )
}
