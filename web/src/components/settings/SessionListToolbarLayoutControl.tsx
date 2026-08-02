import { useState, type DragEvent } from 'react'
import { SessionListToolbarItemIcon, CalendarIcon, PlusIcon, SearchIcon, SettingsIcon } from '@/components/SessionListToolbarIcons'
import {
    moveSessionListToolbarItem,
    SESSION_LIST_TOOLBAR_ITEM_IDS,
    useSessionListToolbarLayout,
    type SessionListSearchPresentation,
    type SessionListToolbarGroup,
    type SessionListToolbarItemId,
} from '@/hooks/useSessionListToolbarLayout'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'
import { SettingsChoiceGroup } from './SettingsPrimitives'

const ITEM_LABEL_KEYS: Record<SessionListToolbarItemId, string> = {
    search: 'settings.display.sessionToolbar.item.search',
    dateFilter: 'settings.display.sessionToolbar.item.dateFilter',
    machineFilter: 'settings.display.sessionToolbar.item.machineFilter',
    codexImport: 'settings.display.sessionToolbar.item.codexImport',
    refresh: 'settings.display.sessionToolbar.item.refresh',
    browse: 'settings.display.sessionToolbar.item.browse',
}

export function SessionListToolbarLayoutControl() {
    const { t } = useTranslation()
    const { layout, setLayout, resetLayout } = useSessionListToolbarLayout()
    const [draggedItem, setDraggedItem] = useState<SessionListToolbarItemId | null>(null)
    const [selectedItem, setSelectedItem] = useState<SessionListToolbarItemId | null>(null)

    const moveDraggedItem = (group: SessionListToolbarGroup, index: number) => {
        if (!draggedItem) return
        const next = moveSessionListToolbarItem(layout, draggedItem, group, index)
        const unchanged = next.left.join() === layout.left.join()
            && next.right.join() === layout.right.join()
            && next.hidden.join() === layout.hidden.join()
        if (!unchanged) setLayout(next)
    }

    const onDrop = (event: DragEvent, group: SessionListToolbarGroup, index: number) => {
        event.preventDefault()
        const item = draggedItem ?? event.dataTransfer.getData('text/plain')
        if ((SESSION_LIST_TOOLBAR_ITEM_IDS as readonly string[]).includes(item)) {
            setLayout(moveSessionListToolbarItem(layout, item as SessionListToolbarItemId, group, index))
        }
        setDraggedItem(null)
    }

    const moveItemByOffset = (
        item: SessionListToolbarItemId,
        group: SessionListToolbarGroup,
        index: number,
        offset: -1 | 1,
    ) => {
        setLayout(moveSessionListToolbarItem(layout, item, group, Math.max(0, index + offset)))
    }

    const searchVisible = !layout.hidden.includes('search')
    const dateEmbedded = searchVisible && layout.searchPresentation === 'field' && !layout.hidden.includes('dateFilter')

    const renderItem = (
        item: SessionListToolbarItemId,
        group: SessionListToolbarGroup,
        index: number,
    ) => {
        const label = t(ITEM_LABEL_KEYS[item])
        const fieldPreview = item === 'search' && group !== 'hidden' && layout.searchPresentation === 'field'
        const embeddedPlaceholder = item === 'dateFilter' && group !== 'hidden' && dateEmbedded
        return (
            <button
                key={item}
                type="button"
                draggable
                aria-label={label}
                title={embeddedPlaceholder ? t('settings.display.sessionToolbar.dateEmbedded') : label}
                aria-pressed={selectedItem === item}
                onDragStart={(event) => {
                    setDraggedItem(item)
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', item)
                }}
                onDragEnter={(event) => {
                    event.preventDefault()
                    moveDraggedItem(group, index)
                }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                    event.stopPropagation()
                    onDrop(event, group, index)
                }}
                onDragEnd={() => setDraggedItem(null)}
                onClick={() => setSelectedItem((current) => current === item ? null : item)}
                onKeyDown={(event) => {
                    if (event.key === 'ArrowLeft' && index > 0) {
                        event.preventDefault()
                        moveItemByOffset(item, group, index, -1)
                    }
                    if (event.key === 'ArrowRight') {
                        event.preventDefault()
                        moveItemByOffset(item, group, index, 1)
                    }
                }}
                className={cn(
                    'relative flex shrink-0 cursor-grab items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-bg)] active:cursor-grabbing',
                    fieldPreview ? 'h-8 min-w-24 flex-1 justify-start gap-1.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5' : 'h-8 w-8',
                    selectedItem === item && 'ring-1 ring-[var(--app-link)]',
                    draggedItem === item && 'opacity-35',
                    embeddedPlaceholder && 'border border-dashed border-[var(--app-border)] opacity-40'
                )}
            >
                {fieldPreview ? (
                    <>
                        <SearchIcon className="h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0 flex-1 truncate text-left text-xs">{t('sessions.search.placeholder')}</span>
                        {dateEmbedded ? <CalendarIcon className="h-4 w-4 shrink-0" /> : null}
                    </>
                ) : <SessionListToolbarItemIcon item={item} className="h-5 w-5" />}
            </button>
        )
    }

    const renderGroup = (group: SessionListToolbarGroup, items: SessionListToolbarItemId[], grow = false) => (
        <div
            className={cn(
                'flex min-h-10 min-w-10 items-center gap-2 rounded-lg',
                grow ? 'min-w-0 flex-1' : 'shrink-0',
                group === 'hidden' && 'flex-wrap'
            )}
            onDragEnter={(event) => {
                if (event.target === event.currentTarget) moveDraggedItem(group, items.length)
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => onDrop(event, group, items.length)}
        >
            {items.map((item, index) => renderItem(item, group, index))}
        </div>
    )

    const selectedGroup: SessionListToolbarGroup = selectedItem && layout.hidden.includes(selectedItem)
        ? 'hidden'
        : selectedItem && layout.right.includes(selectedItem) ? 'right' : 'left'
    const selectedItems = layout[selectedGroup]
    const selectedIndex = selectedItem ? selectedItems.indexOf(selectedItem) : -1
    const selectedIsVisible = selectedGroup !== 'hidden'
    const fieldInLeft = searchVisible && layout.searchPresentation === 'field' && layout.left.includes('search')
    const fieldInRight = searchVisible && layout.searchPresentation === 'field' && layout.right.includes('search')

    return (
        <div className="border-t border-[var(--app-divider)] py-3">
            <div className="mb-3 px-3">
                <h3 className="text-sm font-medium text-[var(--app-fg)]">{t('settings.display.sessionToolbar.title')}</h3>
                <p className="mt-0.5 text-xs text-[var(--app-hint)]">{t('settings.display.sessionToolbar.description')}</p>
            </div>

            <SettingsChoiceGroup
                label={t('settings.display.sessionToolbar.searchLayout')}
                value={layout.searchPresentation}
                options={([
                    ['icon', 'settings.display.sessionToolbar.searchLayout.icon'],
                    ['field', 'settings.display.sessionToolbar.searchLayout.field'],
                ] as const).map(([value, labelKey]) => ({ value, label: t(labelKey) }))}
                onChange={(searchPresentation: SessionListSearchPresentation) => setLayout({ ...layout, searchPresentation })}
            />

            <div className="mt-3 flex items-center justify-between gap-3 px-3">
                <div>
                    <h4 className="text-sm font-medium text-[var(--app-fg)]">{t('settings.display.sessionToolbar.order')}</h4>
                    <p className="mt-0.5 text-xs text-[var(--app-hint)]">{t('settings.display.sessionToolbar.previewHint')}</p>
                </div>
                <button type="button" onClick={resetLayout} className="shrink-0 text-sm text-[var(--app-link)] hover:underline">{t('settings.display.sessionToolbar.reset')}</button>
            </div>

            <div className="mx-3 mt-2 overflow-x-auto rounded-xl bg-[var(--app-subtle-bg)] px-2 py-2 ring-1 ring-[var(--app-border)]">
                <div className="flex min-w-full items-center gap-2">
                    {renderGroup('left', layout.left, fieldInLeft)}
                    {!fieldInLeft && !fieldInRight ? <span className="min-w-2 flex-1" aria-hidden="true" /> : null}
                    {renderGroup('right', layout.right, fieldInRight)}
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)]" title={t('settings.title')}><SettingsIcon className="h-5 w-5" /></span>
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--app-link)]" title={t('sessions.new')}><PlusIcon className="h-6 w-6" /></span>
                </div>
            </div>

            <div className="mx-3 mt-3">
                <h4 className="text-sm font-medium text-[var(--app-fg)]">{t('settings.display.sessionToolbar.hidden')}</h4>
                <p className="mt-0.5 text-xs text-[var(--app-hint)]">{t('settings.display.sessionToolbar.fixedHint')}</p>
                <div className="mt-2 min-h-12 rounded-xl border border-dashed border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-1">
                    {layout.hidden.length > 0 ? renderGroup('hidden', layout.hidden, true) : (
                        <div
                            className="flex min-h-10 items-center justify-center text-xs text-[var(--app-hint)]"
                            onDragOver={(event) => event.preventDefault()}
                            onDrop={(event) => onDrop(event, 'hidden', 0)}
                        >
                            {t('settings.display.sessionToolbar.emptyHidden')}
                        </div>
                    )}
                </div>
            </div>

            {selectedItem && selectedIndex >= 0 ? (
                <div className="mx-3 mt-2 flex items-center justify-between gap-2 rounded-lg bg-[var(--app-subtle-bg)] px-3 py-2 text-sm">
                    <span className="min-w-0 truncate text-[var(--app-hint)]">{t(ITEM_LABEL_KEYS[selectedItem])}</span>
                    <span className="flex shrink-0 items-center gap-1">
                        <button
                            type="button"
                            disabled={selectedIndex === 0}
                            aria-label={t('settings.display.sessionToolbar.moveEarlier')}
                            title={t('settings.display.sessionToolbar.moveEarlier')}
                            onClick={() => moveItemByOffset(selectedItem, selectedGroup, selectedIndex, -1)}
                            className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-[var(--app-bg)] disabled:opacity-35"
                        >←</button>
                        <button
                            type="button"
                            disabled={selectedIndex === selectedItems.length - 1}
                            aria-label={t('settings.display.sessionToolbar.moveLater')}
                            title={t('settings.display.sessionToolbar.moveLater')}
                            onClick={() => moveItemByOffset(selectedItem, selectedGroup, selectedIndex, 1)}
                            className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-[var(--app-bg)] disabled:opacity-35"
                        >→</button>
                        {selectedIsVisible ? (
                            <>
                                <button
                                    type="button"
                                    onClick={() => setLayout(moveSessionListToolbarItem(layout, selectedItem, selectedGroup === 'left' ? 'right' : 'left', selectedGroup === 'left' ? layout.right.length : layout.left.length))}
                                    className="ml-1 rounded-lg px-2.5 py-1.5 text-xs text-[var(--app-link)] hover:bg-[var(--app-bg)]"
                                >
                                    {selectedGroup === 'left' ? t('settings.display.sessionToolbar.rightGroup') : t('settings.display.sessionToolbar.leftGroup')}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setLayout(moveSessionListToolbarItem(layout, selectedItem, 'hidden', layout.hidden.length))}
                                    className="rounded-lg px-2.5 py-1.5 text-xs text-[var(--app-link)] hover:bg-[var(--app-bg)]"
                                >{t('settings.display.sessionToolbar.hide')}</button>
                            </>
                        ) : (
                            <button
                                type="button"
                                onClick={() => setLayout(moveSessionListToolbarItem(layout, selectedItem, 'right', layout.right.length))}
                                className="ml-1 rounded-lg px-2.5 py-1.5 text-xs text-[var(--app-link)] hover:bg-[var(--app-bg)]"
                            >{t('settings.display.sessionToolbar.show')}</button>
                        )}
                    </span>
                </div>
            ) : null}

        </div>
    )
}
