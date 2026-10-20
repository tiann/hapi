import { useEffect, useRef, useState } from 'react'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/use-translation'

type RenameGroupDialogProps = {
    isOpen: boolean
    onClose: () => void
    currentName: string
    directory?: string | null
    /** New display name, or null when the input is cleared (reset to default). */
    onRename: (name: string | null) => void
}

export function RenameGroupDialog(props: RenameGroupDialogProps) {
    const { t } = useTranslation()
    const { isOpen, onClose, currentName, directory, onRename } = props
    const [name, setName] = useState(currentName)
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        if (!isOpen) return
        setName(currentName)
        const timer = setTimeout(() => {
            inputRef.current?.focus()
            inputRef.current?.select()
        }, 100)
        return () => clearTimeout(timer)
    }, [isOpen, currentName])

    const handleClose = () => {
        onClose()
    }

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault()
        const trimmed = name.trim()
        onRename(trimmed ? trimmed : null)
        handleClose()
    }

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            handleClose()
        }
    }

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
            <DialogContent className="max-w-sm">
                <DialogHeader className="pr-0">
                    <DialogTitle className="min-h-6 px-10 text-center leading-6">
                        {t('dialog.renameGroup.title')}
                    </DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-4">
                    <input
                        ref={inputRef}
                        type="text"
                        value={name}
                        data-testid="rename-group-input"
                        onChange={(e) => setName(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={t('dialog.renameGroup.placeholder')}
                        className="w-full px-3 py-2.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-2 focus:ring-[var(--app-button)] focus:border-transparent"
                        maxLength={255}
                        autoComplete="off"
                    />

                    {directory ? (
                        <div className="text-xs text-[var(--app-hint)] break-all">
                            {t('dialog.renameGroup.hint', { path: directory })}
                        </div>
                    ) : null}

                    <div className="flex items-center justify-between gap-2">
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={handleClose}
                        >
                            {t('button.cancel')}
                        </Button>
                        <Button
                            type="submit"
                            data-testid="rename-group-save"
                        >
                            {t('dialog.renameGroup.save')}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    )
}
