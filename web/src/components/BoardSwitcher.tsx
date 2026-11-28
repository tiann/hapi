import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CheckIcon, CloseIcon, FilterIcon, PlusIcon } from '@/components/icons'
import { chipBaseClass, chipIdleClass, chipSelectedClass } from '@/components/filterChipStyles'
import { getMachineFilterMenuClampStyle } from '@/components/MachineFilterBar'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

export type BoardFilterItem = {
    id: string
    label: string
}

// Board switcher: same chip-row pattern as MachineFilterBar, minus the "All"
// pseudo-chip — board selection has no unfiltered state, exactly one board is
// always selected (hapi#235). Each chip is a wrapping <div>, not a <button>,
// because it holds two independent actions (select, remove) — nesting a
// remove <button> inside a select <button> would be invalid HTML.
export function BoardSwitcherBar(props: {
    boards: BoardFilterItem[]
    value: string | null
    onChange: (id: string) => void
    onRemove: (id: string) => void
    onAddClick: () => void
}) {
    const { t } = useTranslation()
    return (
        <div
            role="radiogroup"
            aria-label={t('boards.boardSwitcher.label')}
            className="flex flex-wrap items-center gap-1.5 px-2 pb-2 max-md:hidden"
        >
            {props.boards.map((board) => {
                const selected = props.value === board.id
                return (
                    <div key={board.id} className={cn(chipBaseClass, 'gap-1', selected ? chipSelectedClass : chipIdleClass)}>
                        <button
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            onClick={() => props.onChange(board.id)}
                            className="max-w-48 truncate focus-visible:outline-none"
                        >
                            {board.label}
                        </button>
                        <button
                            type="button"
                            onClick={() => props.onRemove(board.id)}
                            aria-label={t('boards.removeBoard.label', { label: board.label })}
                            title={t('boards.removeBoard.label', { label: board.label })}
                            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full opacity-60 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                        >
                            <CloseIcon className="h-3 w-3" />
                        </button>
                    </div>
                )
            })}
            <button
                type="button"
                onClick={props.onAddClick}
                aria-label={t('boards.addBoard.chipLabel')}
                title={t('boards.addBoard.chipLabel')}
                className={cn(chipBaseClass, chipIdleClass, 'px-2')}
            >
                <PlusIcon className="h-3.5 w-3.5" />
            </button>
        </div>
    )
}

// Mobile (below md) counterpart: collapses the board switcher into a single
// header icon button with a dropdown, mirroring MachineFilterMenu.
export function BoardSwitcherMenu(props: {
    boards: BoardFilterItem[]
    value: string | null
    onChange: (id: string) => void
    onRemove: (id: string) => void
    onAddClick: () => void
}) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    const triggerRef = useRef<HTMLButtonElement>(null)
    const wrapperRef = useRef<HTMLDivElement>(null)
    const menuRef = useRef<HTMLDivElement>(null)
    const [anchor, setAnchor] = useState<{ left: number; right: number; bottom: number } | null>(null)

    const close = useCallback(() => {
        setOpen(false)
        triggerRef.current?.focus()
    }, [])

    const select = (id: string) => {
        props.onChange(id)
        close()
    }

    useLayoutEffect(() => {
        if (!open) {
            setAnchor(null)
            return
        }
        const updateAnchor = () => {
            const rect = wrapperRef.current?.getBoundingClientRect()
            if (!rect) return
            setAnchor({ left: rect.left, right: rect.right, bottom: rect.bottom })
        }
        updateAnchor()
        window.addEventListener('resize', updateAnchor)
        return () => window.removeEventListener('resize', updateAnchor)
    }, [open])

    useEffect(() => {
        if (!open) return

        const frame = window.requestAnimationFrame(() => {
            const selected = menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')
            const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"]')
            ;(selected ?? first)?.focus()
        })

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault()
                close()
                return
            }
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            const items = Array.from(
                menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []
            )
            if (items.length === 0) return
            event.preventDefault()
            const delta = event.key === 'ArrowDown' ? 1 : -1
            const currentIndex = items.indexOf(document.activeElement as HTMLElement)
            const nextIndex = currentIndex === -1
                ? (delta === 1 ? 0 : items.length - 1)
                : (currentIndex + delta + items.length) % items.length
            items[nextIndex]?.focus()
        }

        document.addEventListener('keydown', handleKeyDown)
        return () => {
            window.cancelAnimationFrame(frame)
            document.removeEventListener('keydown', handleKeyDown)
        }
    }, [open, close])

    return (
        <div ref={wrapperRef} className="relative shrink-0 md:hidden">
            <button
                ref={triggerRef}
                type="button"
                onClick={() => setOpen(value => !value)}
                aria-label={t('boards.boardSwitcher.label')}
                title={t('boards.boardSwitcher.label')}
                aria-haspopup="menu"
                aria-expanded={open}
                className="relative flex rounded-full p-1.5 text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
            >
                <FilterIcon className="h-5 w-5" />
            </button>
            {open ? (
                <>
                    <button
                        type="button"
                        aria-label={t('button.close')}
                        tabIndex={-1}
                        className="fixed inset-0 z-20 cursor-default"
                        onClick={close}
                    />
                    <div
                        ref={menuRef}
                        role="menu"
                        aria-label={t('boards.boardSwitcher.label')}
                        style={anchor ? getMachineFilterMenuClampStyle(anchor) : undefined}
                        className="absolute right-0 top-full z-30 mt-1 max-h-80 w-64 overflow-y-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-xl"
                    >
                        {props.boards.map((board) => (
                            <div key={board.id} className="flex w-full items-center gap-1 rounded-lg hover:bg-[var(--app-subtle-bg)]">
                                <button
                                    type="button"
                                    role="menuitemradio"
                                    aria-checked={props.value === board.id}
                                    onClick={() => select(board.id)}
                                    className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                >
                                    <span className="flex h-5 w-4 shrink-0 items-center justify-center text-[var(--app-link)]">
                                        {props.value === board.id ? <CheckIcon className="h-4 w-4" /> : null}
                                    </span>
                                    <span className="min-w-0 flex-1 truncate text-[var(--app-fg)]">{board.label}</span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => props.onRemove(board.id)}
                                    aria-label={t('boards.removeBoard.label', { label: board.label })}
                                    title={t('boards.removeBoard.label', { label: board.label })}
                                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] opacity-60 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                >
                                    <CloseIcon className="h-3.5 w-3.5" />
                                </button>
                            </div>
                        ))}
                        <button
                            type="button"
                            onClick={() => { props.onAddClick(); close() }}
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-[var(--app-link)] transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                        >
                            <span className="flex h-5 w-4 shrink-0 items-center justify-center">
                                <PlusIcon className="h-4 w-4" />
                            </span>
                            {t('boards.addBoard.chipLabel')}
                        </button>
                    </div>
                </>
            ) : null}
        </div>
    )
}
