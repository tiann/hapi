import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import * as Popover from '@radix-ui/react-popover'

export type SelectMenuOption = {
    value: string
    label: ReactNode
    disabled?: boolean
}

export type SelectMenuProps = {
    value: string
    options: ReadonlyArray<SelectMenuOption>
    onChange: (value: string) => void
    'aria-label': string
    disabled?: boolean
    placeholder?: ReactNode
    containerClassName?: string
    className?: string
}

function ChevronDownIcon() {
    return (
        <svg
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-[var(--app-fg)]"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="m6 9 6 6 6-6" />
        </svg>
    )
}

function CheckIcon() {
    return (
        <svg
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-[var(--app-link)]"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="m20 6-11 11-5-5" />
        </svg>
    )
}

function firstEnabled(options: ReadonlyArray<SelectMenuOption>): SelectMenuOption | undefined {
    return options.find((option) => !option.disabled)
}

function findEnabledIndex(options: ReadonlyArray<SelectMenuOption>, value: string): number {
    const index = options.findIndex((option) => option.value === value && !option.disabled)
    return index >= 0 ? index : options.findIndex((option) => !option.disabled)
}

function nextEnabledIndex(options: ReadonlyArray<SelectMenuOption>, start: number, direction: 1 | -1): number {
    if (options.length === 0) return -1
    let index = start
    for (let step = 0; step < options.length; step += 1) {
        index = (index + direction + options.length) % options.length
        if (!options[index].disabled) return index
    }
    return start
}

/**
 * Hapi-themed, non-native select menu used where the browser's option popup
 * needs to match the application's surface, typography, and dark theme.
 */
export function SelectMenu(props: SelectMenuProps) {
    const [open, setOpen] = useState(false)
    const [highlightedValue, setHighlightedValue] = useState(props.value)
    const triggerRef = useRef<HTMLButtonElement>(null)
    const optionRefs = useRef(new Map<string, HTMLButtonElement>())
    const listboxId = useId()
    const selected = props.options.find((option) => option.value === props.value)
    const selectedLabel = selected?.label ?? props.placeholder ?? '—'
    const highlighted = props.options.find((option) => option.value === highlightedValue && !option.disabled)
        ?? firstEnabled(props.options)

    useEffect(() => {
        if (!open || !highlighted) return
        optionRefs.current.get(highlighted.value)?.focus()
    }, [open, highlighted?.value])

    const setOpenAndHighlight = (nextOpen: boolean) => {
        setOpen(nextOpen)
        if (nextOpen) setHighlightedValue(props.value)
    }

    const choose = (option: SelectMenuOption) => {
        if (option.disabled) return
        props.onChange(option.value)
        setOpen(false)
        triggerRef.current?.focus()
    }

    const moveHighlight = (direction: 1 | -1) => {
        const currentIndex = findEnabledIndex(props.options, highlightedValue)
        if (currentIndex < 0) return
        const nextIndex = nextEnabledIndex(props.options, currentIndex, direction)
        const next = nextIndex >= 0 ? props.options[nextIndex] : undefined
        if (!next || next.disabled) return
        setHighlightedValue(next.value)
        optionRefs.current.get(next.value)?.focus()
    }

    const highlightBoundary = (boundary: 'first' | 'last') => {
        const enabled = props.options.filter((option) => !option.disabled)
        const next = boundary === 'first' ? enabled[0] : enabled[enabled.length - 1]
        if (!next) return
        setHighlightedValue(next.value)
        optionRefs.current.get(next.value)?.focus()
    }

    const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
            event.preventDefault()
            setOpenAndHighlight(true)
            if (event.key === 'Home') highlightBoundary('first')
            else if (event.key === 'End') highlightBoundary('last')
        }
    }

    const handleOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, option: SelectMenuOption) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault()
            moveHighlight(1)
        } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            moveHighlight(-1)
        } else if (event.key === 'Home') {
            event.preventDefault()
            highlightBoundary('first')
        } else if (event.key === 'End') {
            event.preventDefault()
            highlightBoundary('last')
        } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            choose(option)
        } else if (event.key === 'Escape') {
            event.preventDefault()
            setOpen(false)
            triggerRef.current?.focus()
        } else if (event.key === 'Tab') {
            setOpen(false)
        }
    }

    return (
        <span className={`relative block min-w-0 ${props.containerClassName ?? ''}`}>
            <Popover.Root open={open} onOpenChange={setOpenAndHighlight}>
                <Popover.Trigger asChild>
                    <button
                        ref={triggerRef}
                        type="button"
                        role="combobox"
                        aria-label={props['aria-label']}
                        aria-haspopup="listbox"
                        aria-expanded={open}
                        aria-controls={open ? listboxId : undefined}
                        disabled={props.disabled}
                        onKeyDown={handleTriggerKeyDown}
                        className={`flex min-h-9 w-full items-center justify-between gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-left text-sm text-[var(--app-fg)] outline-none transition-colors hover:bg-[var(--app-subtle-bg)] focus:ring-2 focus:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-50 ${props.className ?? ''}`}
                    >
                        <span className="min-w-0 flex-1 truncate">{selectedLabel}</span>
                        <ChevronDownIcon />
                    </button>
                </Popover.Trigger>
                <Popover.Portal>
                    <Popover.Content
                        side="bottom"
                        align="start"
                        sideOffset={4}
                        collisionPadding={8}
                        onOpenAutoFocus={(event) => event.preventDefault()}
                        onCloseAutoFocus={(event) => event.preventDefault()}
                        className="z-50 max-h-64 w-[var(--radix-popover-trigger-width)] min-w-[12rem] max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-lg outline-none"
                    >
                        <div id={listboxId} role="listbox" aria-label={props['aria-label']}>
                            {props.options.map((option) => {
                                const isSelected = option.value === props.value
                                const isHighlighted = option.value === highlighted?.value
                                return (
                                    <button
                                        key={option.value}
                                        ref={(element) => {
                                            if (element) optionRefs.current.set(option.value, element)
                                            else optionRefs.current.delete(option.value)
                                        }}
                                        type="button"
                                        role="option"
                                        aria-selected={isSelected}
                                        disabled={option.disabled}
                                        tabIndex={isHighlighted ? 0 : -1}
                                        onMouseEnter={() => setHighlightedValue(option.value)}
                                        onClick={() => choose(option)}
                                        onKeyDown={(event) => handleOptionKeyDown(event, option)}
                                        className={`flex min-h-9 w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${option.disabled
                                            ? 'cursor-not-allowed text-[var(--app-hint)] opacity-50'
                                            : isHighlighted || isSelected
                                                ? 'bg-[var(--app-subtle-bg)] text-[var(--app-fg)]'
                                                : 'text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'}`}
                                    >
                                        <span className="min-w-0 flex-1 truncate">{option.label}</span>
                                        <span className="flex h-4 w-4 shrink-0 items-center justify-center">{isSelected ? <CheckIcon /> : null}</span>
                                    </button>
                                )
                            })}
                        </div>
                    </Popover.Content>
                </Popover.Portal>
            </Popover.Root>
        </span>
    )
}
