import { useRef } from 'react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'
import { useFue } from '@/lib/use-fue'
import { FueCallout, FueDot } from '@/components/Fue'

export type SessionsMode = 'sessions' | 'boards'

const MODE_BUTTON_CLASSES =
    'relative h-8 flex-1 rounded-full border text-sm font-medium transition-colors'

function modeButtonVariant(active: boolean): string {
    return active
        ? 'border-[var(--app-link)] bg-[var(--app-subtle-bg)] text-[var(--app-link)]'
        : 'border-[var(--app-border)] text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]'
}

// Global [Sessions] [Boards] switch — one toggle for the whole left pane, not
// per-group (hapi#235 design doc: a per-group toggle would compound the
// orientation problem across 137+ existing session groups).
//
// Boards gets a FUE badge/callout (operator ask) since it's the actual
// discovery affordance — a user has to click it once to find the feature at
// all. Canonical FUE wiring pattern, see ComposerButtons.tsx's
// ScratchlistToggleButton doc comment / web/src/lib/use-fue.ts.
export function SessionsModeSwitch(props: {
    mode: SessionsMode
    onChange: (mode: SessionsMode) => void
}) {
    const { t } = useTranslation()
    const fue = useFue('boards-mode')
    const boardsButtonRef = useRef<HTMLButtonElement>(null)
    const showFueDot = fue.status !== 'acknowledged'

    return (
        <div
            role="radiogroup"
            aria-label={t('sessions.modeSwitch.label')}
            className="flex gap-1 px-2 pb-2"
        >
            <button
                type="button"
                role="radio"
                aria-checked={props.mode === 'sessions'}
                onClick={() => props.onChange('sessions')}
                className={cn(MODE_BUTTON_CLASSES, modeButtonVariant(props.mode === 'sessions'))}
            >
                {t('sessions.modeSwitch.sessions')}
            </button>
            <button
                ref={boardsButtonRef}
                type="button"
                role="radio"
                aria-checked={props.mode === 'boards'}
                onClick={() => {
                    fue.engage()
                    props.onChange('boards')
                }}
                className={cn(MODE_BUTTON_CLASSES, modeButtonVariant(props.mode === 'boards'))}
            >
                {t('sessions.modeSwitch.boards')}
                {showFueDot ? (
                    <FueDot
                        pulsing={fue.status === 'unseen'}
                        ariaLabel={t('fue.newFeatureDot')}
                    />
                ) : null}
            </button>
            {fue.status === 'engaging' ? (
                <FueCallout
                    title={t('boards.fueTitle')}
                    body={t('boards.fueBody')}
                    onDismiss={fue.dismiss}
                    dismissLabel={t('fue.gotIt')}
                    closeAriaLabel={t('fue.closeAriaLabel')}
                    anchorRef={boardsButtonRef}
                />
            ) : null}
        </div>
    )
}
