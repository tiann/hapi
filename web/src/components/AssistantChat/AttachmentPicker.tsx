import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useCallback, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { CloseIcon } from '@/components/icons'
import { useTranslation } from '@/lib/use-translation'

type AttachmentSource = 'photos' | 'camera' | 'files'

export type AttachmentPickerProps = {
    disabled?: boolean
    onFilesSelected: (files: readonly File[]) => void | Promise<void>
}

function PaperclipIcon() {
    return (
        <svg
            aria-hidden="true"
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M21.44 11.05l-8.49 8.49a5.5 5.5 0 0 1-7.78-7.78l8.49-8.49a3.5 3.5 0 0 1 4.95 4.95l-8.49 8.49a1.5 1.5 0 0 1-2.12-2.12l7.78-7.78" />
        </svg>
    )
}

function PhotoIcon() {
    return (
        <svg
            aria-hidden="true"
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <rect x="3" y="4" width="18" height="16" rx="3" />
            <circle cx="8.5" cy="9.5" r="1.5" />
            <path d="m3 16 4.5-4.5a2 2 0 0 1 2.8 0l2.2 2.2 1.2-1.2a2 2 0 0 1 2.8 0L21 15.9" />
        </svg>
    )
}

function CameraIcon() {
    return (
        <svg
            aria-hidden="true"
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6H8l1.2-2h5.6L16 6h1.5A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5Z" />
            <circle cx="12" cy="12.5" r="3.25" />
        </svg>
    )
}

function FileIcon() {
    return (
        <svg
            aria-hidden="true"
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M6 3h8l4 4v14H6z" />
            <path d="M14 3v5h5M9 13h6M9 17h6" />
        </svg>
    )
}

function PickerAction(props: {
    label: string
    icon: ReactNode
    onClick: () => void
    testId: string
}) {
    return (
        <button
            type="button"
            data-testid={props.testId}
            onClick={props.onClick}
            className="flex min-h-24 flex-col items-center justify-center gap-2 rounded-2xl border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-3 text-sm font-medium text-[var(--app-fg)] transition-colors hover:border-[var(--app-link)] hover:bg-[var(--app-subtle-bg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--app-link)] active:scale-[0.98]"
        >
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--app-subtle-bg)] text-[var(--app-fg)]/70">
                {props.icon}
            </span>
            <span>{props.label}</span>
        </button>
    )
}

export function AttachmentPicker(props: AttachmentPickerProps) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    const photosInputRef = useRef<HTMLInputElement>(null)
    const cameraInputRef = useRef<HTMLInputElement>(null)
    const filesInputRef = useRef<HTMLInputElement>(null)

    const handleInputChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.currentTarget.files ?? [])
        // Reset the native input so choosing the same file again still emits a
        // change event after the attachment has been removed.
        event.currentTarget.value = ''
        if (files.length === 0) return
        props.onFilesSelected(files)
    }, [props.onFilesSelected])

    const openSource = useCallback((source: AttachmentSource) => {
        setOpen(false)
        if (source === 'photos') {
            photosInputRef.current?.click()
        } else if (source === 'camera') {
            cameraInputRef.current?.click()
        } else {
            filesInputRef.current?.click()
        }
    }, [])

    return (
        <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
            <DialogPrimitive.Trigger asChild>
                <button
                    type="button"
                    data-testid="composer-attachment-picker-trigger"
                    aria-label={t('composer.attach')}
                    title={t('composer.attach')}
                    disabled={props.disabled}
                    className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-fg)]/60 transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                    <PaperclipIcon />
                </button>
            </DialogPrimitive.Trigger>

            <DialogPrimitive.Portal>
                <DialogPrimitive.Overlay className="fixed inset-0 z-[70] bg-black/45" />
                <DialogPrimitive.Content
                    data-testid="composer-attachment-picker"
                    className="fixed inset-x-0 bottom-0 z-[71] mx-auto w-full max-w-lg rounded-t-[28px] border border-[var(--app-border)] bg-[var(--app-dialog-bg)] p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] shadow-2xl animate-slide-up sm:bottom-4 sm:rounded-2xl"
                >
                    <div className="flex items-center justify-between gap-3 px-1">
                        <DialogPrimitive.Title className="text-base font-semibold text-[var(--app-fg)]">
                            {t('composer.attachmentPicker.title')}
                        </DialogPrimitive.Title>
                        <DialogPrimitive.Close asChild>
                            <button
                                type="button"
                                aria-label={t('button.close')}
                                title={t('button.close')}
                                className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--app-link)]"
                            >
                                <CloseIcon className="h-4 w-4" />
                            </button>
                        </DialogPrimitive.Close>
                    </div>
                    <DialogPrimitive.Description className="sr-only">
                        {t('composer.attachmentPicker.description')}
                    </DialogPrimitive.Description>

                    <div className="grid grid-cols-3 gap-2 pt-3">
                        <PickerAction
                            testId="composer-attachment-picker-photos"
                            label={t('composer.attachmentPicker.photos')}
                            icon={<PhotoIcon />}
                            onClick={() => openSource('photos')}
                        />
                        <PickerAction
                            testId="composer-attachment-picker-camera"
                            label={t('composer.attachmentPicker.camera')}
                            icon={<CameraIcon />}
                            onClick={() => openSource('camera')}
                        />
                        <PickerAction
                            testId="composer-attachment-picker-files"
                            label={t('composer.attachmentPicker.files')}
                            icon={<FileIcon />}
                            onClick={() => openSource('files')}
                        />
                    </div>
                </DialogPrimitive.Content>
            </DialogPrimitive.Portal>

            <input
                ref={photosInputRef}
                type="file"
                accept="image/*"
                multiple
                tabIndex={-1}
                aria-hidden="true"
                className="hidden"
                data-testid="composer-attachment-input-photos"
                onChange={handleInputChange}
            />
            <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                tabIndex={-1}
                aria-hidden="true"
                className="hidden"
                data-testid="composer-attachment-input-camera"
                onChange={handleInputChange}
            />
            <input
                ref={filesInputRef}
                type="file"
                accept="*/*"
                multiple
                tabIndex={-1}
                aria-hidden="true"
                className="hidden"
                data-testid="composer-attachment-input-files"
                onChange={handleInputChange}
            />
        </DialogPrimitive.Root>
    )
}
