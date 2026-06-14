import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import { useLongPress } from '@/hooks/useLongPress'

// A quick-input key for driving a TUI from a touch device (or any viewer): a
// labelled button that sends a raw terminal sequence, optionally a long-press
// alternate, or a sticky Ctrl/Alt modifier toggle.
export type QuickInput = {
    label: string
    sequence?: string
    description: string
    modifier?: 'ctrl' | 'alt'
    popup?: {
        label: string
        sequence: string
        description: string
    }
}

export type ModifierState = {
    ctrl: boolean
    alt: boolean
}

// Apply the sticky Ctrl/Alt modifiers to a raw sequence: Alt prefixes ESC, Ctrl
// maps a single printable letter to its control code (C0). Multi-char sequences
// (arrows, paste) only receive the Alt prefix — Ctrl is meaningless there.
export function applyModifierState(sequence: string, state: ModifierState): string {
    let modified = sequence
    if (state.alt) {
        modified = `\u001b${modified}`
    }
    if (state.ctrl && modified.length === 1) {
        const code = modified.toUpperCase().charCodeAt(0)
        if (code >= 64 && code <= 95) {
            modified = String.fromCharCode(code - 64)
        }
    }
    return modified
}

// A sticky modifier is consumed (and should reset) once a real sequence is sent.
export function shouldResetModifiers(sequence: string, state: ModifierState): boolean {
    if (!sequence) {
        return false
    }
    return state.ctrl || state.alt
}

export const QUICK_INPUT_ROWS: QuickInput[][] = [
    [
        { label: 'Esc', sequence: '\u001b', description: 'Escape' },
        {
            label: '/',
            sequence: '/',
            description: 'Forward slash',
            popup: { label: '?', sequence: '?', description: 'Question mark' },
        },
        {
            label: '-',
            sequence: '-',
            description: 'Hyphen',
            popup: { label: '|', sequence: '|', description: 'Pipe' },
        },
        { label: 'Home', sequence: '\u001b[H', description: 'Home' },
        { label: '↑', sequence: '\u001b[A', description: 'Arrow up' },
        { label: 'End', sequence: '\u001b[F', description: 'End' },
        { label: 'PgUp', sequence: '\u001b[5~', description: 'Page up' },
    ],
    [
        { label: 'Tab', sequence: '\t', description: 'Tab' },
        { label: 'Ctrl', description: 'Control', modifier: 'ctrl' },
        { label: 'Alt', description: 'Alternate', modifier: 'alt' },
        { label: '←', sequence: '\u001b[D', description: 'Arrow left' },
        { label: '↓', sequence: '\u001b[B', description: 'Arrow down' },
        { label: '→', sequence: '\u001b[C', description: 'Arrow right' },
        { label: 'PgDn', sequence: '\u001b[6~', description: 'Page down' },
    ],
]

function QuickKeyButton(props: {
    input: QuickInput
    disabled: boolean
    isActive: boolean
    onPress: (sequence: string) => void
    onToggleModifier: (modifier: 'ctrl' | 'alt') => void
}) {
    const { input, disabled, isActive, onPress, onToggleModifier } = props
    const modifier = input.modifier
    const popupSequence = input.popup?.sequence
    const popupDescription = input.popup?.description
    const hasPopup = Boolean(popupSequence)
    const longPressDisabled = disabled || Boolean(modifier) || !hasPopup

    const handleClick = useCallback(() => {
        if (modifier) {
            onToggleModifier(modifier)
            return
        }
        onPress(input.sequence ?? '')
    }, [modifier, onToggleModifier, onPress, input.sequence])

    const handlePointerDown = useCallback((event: PointerEvent<HTMLButtonElement>) => {
        if (event.pointerType === 'touch') {
            event.preventDefault()
        }
    }, [])

    const longPressHandlers = useLongPress({
        onLongPress: () => {
            if (popupSequence && !modifier) {
                onPress(popupSequence)
            }
        },
        onClick: handleClick,
        disabled: longPressDisabled,
    })

    return (
        <button
            type="button"
            {...longPressHandlers}
            onPointerDown={handlePointerDown}
            disabled={disabled}
            aria-pressed={modifier ? isActive : undefined}
            className={`flex-1 border-l border-[var(--app-border)] px-2 py-1.5 text-xs font-medium text-[var(--app-fg)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-button)] focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent first:border-l-0 active:bg-[var(--app-subtle-bg)] sm:px-3 sm:text-sm ${
                isActive ? 'bg-[var(--app-link)] text-[var(--app-bg)]' : 'hover:bg-[var(--app-subtle-bg)]'
            }`}
            aria-label={input.description}
            title={popupDescription ? `${input.description} (long press: ${popupDescription})` : input.description}
        >
            {input.label}
        </button>
    )
}

// Sticky-modifier state + a dispatcher that applies the modifiers and resets
// them after a real send. Shared by the quick-key buttons AND the terminal's
// raw onData path so toggling Ctrl then typing a letter sends the control code,
// exactly like a physical modifier key. Gating (when to disable) is the caller's
// concern — the quick-key buttons gate via their `disabled` prop, while the raw
// onData path is intentionally ungated.
export function useQuickKeyInput(opts: { onSend: (data: string) => void }): {
    ctrlActive: boolean
    altActive: boolean
    dispatch: (sequence: string) => void
    toggleModifier: (modifier: 'ctrl' | 'alt') => void
    resetModifiers: () => void
} {
    const [ctrlActive, setCtrlActive] = useState(false)
    const [altActive, setAltActive] = useState(false)
    // Read modifiers from a ref inside dispatch so the terminal onData closure
    // (registered once) always sees the current state, never a stale snapshot.
    const modifierStateRef = useRef<ModifierState>({ ctrl: false, alt: false })
    useEffect(() => {
        modifierStateRef.current = { ctrl: ctrlActive, alt: altActive }
    }, [ctrlActive, altActive])
    const onSendRef = useRef(opts.onSend)
    useEffect(() => {
        onSendRef.current = opts.onSend
    }, [opts.onSend])

    const resetModifiers = useCallback(() => {
        setCtrlActive(false)
        setAltActive(false)
    }, [])

    const dispatch = useCallback((sequence: string) => {
        const state = modifierStateRef.current
        onSendRef.current(applyModifierState(sequence, state))
        if (shouldResetModifiers(sequence, state)) {
            resetModifiers()
        }
    }, [resetModifiers])

    const toggleModifier = useCallback((modifier: 'ctrl' | 'alt') => {
        if (modifier === 'ctrl') {
            setCtrlActive((value) => !value)
            setAltActive(false)
        } else {
            setAltActive((value) => !value)
            setCtrlActive(false)
        }
    }, [])

    return { ctrlActive, altActive, dispatch, toggleModifier, resetModifiers }
}

// Presentational rows of quick-input keys. State/dispatch live in the caller
// (via useQuickKeyInput) so they can be shared with the terminal onData path.
export function QuickKeyRows(props: {
    ctrlActive: boolean
    altActive: boolean
    disabled: boolean
    onPress: (sequence: string) => void
    onToggleModifier: (modifier: 'ctrl' | 'alt') => void
}) {
    const { ctrlActive, altActive, disabled, onPress, onToggleModifier } = props
    return (
        <>
            {QUICK_INPUT_ROWS.map((row, rowIndex) => (
                <div
                    key={`quick-row-${rowIndex}`}
                    className="flex items-stretch overflow-hidden rounded-md bg-[var(--app-secondary-bg)]"
                >
                    {row.map((input) => {
                        const modifier = input.modifier
                        const isCtrl = modifier === 'ctrl'
                        const isAlt = modifier === 'alt'
                        const isActive = (isCtrl && ctrlActive) || (isAlt && altActive)
                        return (
                            <QuickKeyButton
                                key={input.label}
                                input={input}
                                disabled={disabled}
                                isActive={isActive}
                                onPress={onPress}
                                onToggleModifier={onToggleModifier}
                            />
                        )
                    })}
                </div>
            ))}
        </>
    )
}
