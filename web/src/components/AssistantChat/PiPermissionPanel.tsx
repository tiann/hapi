import { useTranslation } from '@/lib/use-translation'
import type { PermissionMode } from '@/types/api'
import { FloatingOverlay } from '@/components/ChatInput/FloatingOverlay'

export type PermissionModeOption = {
    mode: PermissionMode
    label: string
}

export function PiPermissionPanel(props: {
    options: PermissionModeOption[]
    currentMode?: PermissionMode
    controlsDisabled?: boolean
    onSelect: (mode: PermissionMode) => void
    onClose: () => void
}) {
    const { t } = useTranslation()
    const disabled = props.controlsDisabled ?? false

    return (
        <FloatingOverlay maxHeight={200}>
            <div className="py-2">
                <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                    {t('misc.permissionMode')}
                </div>
                {props.options.map((option) => (
                    <button
                        key={option.mode}
                        type="button"
                        disabled={disabled}
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                            disabled
                                ? 'cursor-not-allowed opacity-50'
                                : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                        }`}
                        onClick={() => {
                            props.onSelect(option.mode)
                            props.onClose()
                        }}
                        onMouseDown={(e) => e.preventDefault()}
                    >
                        <div
                            className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                props.currentMode === option.mode
                                    ? 'border-[var(--app-link)]'
                                    : 'border-[var(--app-hint)]'
                            }`}
                        >
                            {props.currentMode === option.mode && (
                                <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                            )}
                        </div>
                        <span className={props.currentMode === option.mode ? 'text-[var(--app-link)]' : ''}>
                            {option.label}
                        </span>
                    </button>
                ))}
            </div>
        </FloatingOverlay>
    )
}
