import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/use-translation'

export type UriConfirmDialogProps = {
    /** Whether the dialog is visible. */
    open: boolean
    /** The full URL being navigated to. */
    url: string
    /** The scheme portion of the URL (without the colon), e.g. "obsidian". */
    scheme: string
    /** Called when the user dismisses the dialog without navigating. */
    onCancel: () => void
    /** Called when the user chooses to open the link once. */
    onOpen: () => void
    /** Called when the user chooses to always allow this scheme. */
    onAlwaysAllow: (scheme: string) => void
}

/**
 * Confirmation dialog shown before navigating to a non-IANA URI scheme.
 * Follows the RenameSessionDialog pattern (Radix Dialog + Button + i18n).
 */
export function UriConfirmDialog(props: UriConfirmDialogProps) {
    const { open, url, scheme, onCancel, onOpen, onAlwaysAllow } = props
    const { t } = useTranslation()

    // Split URL into scheme prefix and the rest for visual emphasis.
    const schemePrefix = `${scheme}:`
    const urlRemainder = url.startsWith(schemePrefix) ? url.slice(schemePrefix.length) : url

    return (
        <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onCancel()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t('dialog.uri.title')}</DialogTitle>
                </DialogHeader>
                <DialogDescription className="mt-2">
                    {t('dialog.uri.description')}
                </DialogDescription>

                {/* URI display with scheme emphasis */}
                <div className="mt-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2 font-mono text-sm break-all">
                    <span className="font-semibold text-[var(--app-link)]">{schemePrefix}</span>
                    <span className="text-[var(--app-fg)]">{urlRemainder}</span>
                </div>

                <div className="mt-4 flex gap-2 justify-end flex-wrap">
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={onCancel}
                    >
                        {t('button.cancel')}
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        onClick={onOpen}
                    >
                        {t('dialog.uri.open')}
                    </Button>
                    <Button
                        type="button"
                        onClick={() => onAlwaysAllow(scheme)}
                    >
                        {t('dialog.uri.alwaysAllow', { scheme })}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
