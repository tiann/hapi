import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { MODEL_MODES, MODEL_MODE_LABELS, type ModelMode } from '@hapi/protocol'

export function ModelSelectorDialog(props: {
    open: boolean
    onOpenChange: (open: boolean) => void
    currentMode: ModelMode
    onSelect: (mode: ModelMode) => void
}) {
    const handleSelect = (mode: ModelMode) => {
        props.onSelect(mode)
        props.onOpenChange(false)
    }

    return (
        <Dialog open={props.open} onOpenChange={props.onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Select Model</DialogTitle>
                    <DialogDescription>
                        Choose the model for this session. Currently using {MODEL_MODE_LABELS[props.currentMode]}.
                    </DialogDescription>
                </DialogHeader>

                <div className="mt-3 flex flex-col gap-1">
                    {MODEL_MODES.map((mode) => (
                        <button
                            key={mode}
                            type="button"
                            className={`flex items-center gap-3 rounded-lg px-3 py-3 text-left text-sm transition-colors ${
                                props.currentMode === mode
                                    ? 'bg-[var(--app-link)]/10 text-[var(--app-link)]'
                                    : 'hover:bg-[var(--app-secondary-bg)] text-[var(--app-fg)]'
                            }`}
                            onClick={() => handleSelect(mode)}
                        >
                            <div
                                className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                    props.currentMode === mode
                                        ? 'border-[var(--app-link)]'
                                        : 'border-[var(--app-hint)]'
                                }`}
                            >
                                {props.currentMode === mode && (
                                    <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                )}
                            </div>
                            <span className="font-medium">{MODEL_MODE_LABELS[mode]}</span>
                        </button>
                    ))}
                </div>
            </DialogContent>
        </Dialog>
    )
}
