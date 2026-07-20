import { useState, type DragEvent } from 'react'
import { ComposerSendButtonPreview, ComposerToolbarItemPreview } from '@/components/AssistantChat/ComposerButtons'
import {
    COMPOSER_TOOLBAR_ITEM_IDS,
    moveComposerToolbarItem,
    moveComposerToolbarItemInSingleLayout,
    useComposerToolbarLayout,
    type ComposerToolbarGroup,
    type ComposerToolbarItemId,
    type ComposerToolbarLayoutMode,
} from '@/hooks/useComposerToolbarLayout'
import { useTranslation } from '@/lib/use-translation'
import { SettingsChoiceGroup } from './SettingsPrimitives'

const ITEM_LABEL_KEYS: Record<ComposerToolbarItemId, string> = {
    attachment: 'settings.chat.composerToolbar.item.attachment',
    settings: 'settings.chat.composerToolbar.item.settings',
    piModel: 'settings.chat.composerToolbar.item.piModel',
    piThinking: 'settings.chat.composerToolbar.item.piThinking',
    terminal: 'settings.chat.composerToolbar.item.terminal',
    abort: 'settings.chat.composerToolbar.item.abort',
    switch: 'settings.chat.composerToolbar.item.switch',
    voiceMic: 'settings.chat.composerToolbar.item.voiceMic',
    scratchlist: 'settings.chat.composerToolbar.item.scratchlist',
    schedule: 'settings.chat.composerToolbar.item.schedule',
}

export function ComposerToolbarLayoutControl() {
    const { t } = useTranslation()
    const { layout, setLayout, resetLayout } = useComposerToolbarLayout()
    const [draggedItem, setDraggedItem] = useState<ComposerToolbarItemId | null>(null)
    const [selectedItem, setSelectedItem] = useState<ComposerToolbarItemId | null>(null)

    const setMode = (mode: ComposerToolbarLayoutMode) => {
        setLayout({ ...layout, mode })
    }

    const moveDraggedItem = (group: ComposerToolbarGroup, index: number) => {
        if (draggedItem) {
            const next = layout.mode === 'split'
                ? moveComposerToolbarItem(layout, draggedItem, group, index)
                : moveComposerToolbarItemInSingleLayout(layout, draggedItem, index)
            const unchanged = next.left.join() === layout.left.join() && next.right.join() === layout.right.join()
            if (!unchanged) {
                setLayout(next)
            }
        }
    }

    const onDrop = (event: DragEvent, group: ComposerToolbarGroup, index: number) => {
        event.preventDefault()
        const item = draggedItem ?? event.dataTransfer.getData('text/plain')
        if ((COMPOSER_TOOLBAR_ITEM_IDS as readonly string[]).includes(item)) {
            const next = layout.mode === 'split'
                ? moveComposerToolbarItem(layout, item as ComposerToolbarItemId, group, index)
                : moveComposerToolbarItemInSingleLayout(layout, item as ComposerToolbarItemId, index)
            setLayout(next)
        }
        setDraggedItem(null)
    }

    const moveItemByOffset = (item: ComposerToolbarItemId, group: ComposerToolbarGroup, index: number, offset: -1 | 1) => {
        const targetIndex = Math.max(0, index + offset)
        const next = layout.mode === 'split'
            ? moveComposerToolbarItem(layout, item, group, targetIndex)
            : moveComposerToolbarItemInSingleLayout(layout, item, targetIndex)
        setLayout(next)
    }

    const renderItem = (item: ComposerToolbarItemId, group: ComposerToolbarGroup, index: number) => {
        const label = t(ITEM_LABEL_KEYS[item])
        return (
            <button
                key={item}
                type="button"
                draggable
                aria-label={label}
                title={label}
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
                aria-pressed={selectedItem === item}
                className={`cursor-grab rounded-full transition-colors hover:bg-[var(--app-bg)] active:cursor-grabbing ${selectedItem === item ? 'bg-[var(--app-bg)] ring-1 ring-[var(--app-link)]' : ''} ${draggedItem === item ? 'opacity-35' : ''}`}
            >
                <ComposerToolbarItemPreview item={item} label={label} />
            </button>
        )
    }

    const renderGroup = (group: ComposerToolbarGroup, items: ComposerToolbarItemId[], alignment: string, grow: boolean) => (
        <div
            className={`flex min-h-10 min-w-12 items-center gap-1 rounded-lg ${grow ? 'flex-1' : 'shrink-0'} ${alignment}`}
            onDragEnter={(event) => {
                if (event.target === event.currentTarget) {
                    moveDraggedItem(group, items.length)
                }
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => onDrop(event, group, items.length)}
        >
            {items.map((item, index) => renderItem(item, group, index))}
        </div>
    )

    const singleAlignment = layout.mode === 'center' ? 'justify-center' : layout.mode === 'right' ? 'justify-end' : 'justify-start'
    const singleItems = [...layout.left, ...layout.right]
    const selectedGroup: ComposerToolbarGroup = selectedItem && layout.right.includes(selectedItem) ? 'right' : 'left'
    const selectedItems = layout.mode === 'split' ? layout[selectedGroup] : singleItems
    const selectedIndex = selectedItem ? selectedItems.indexOf(selectedItem) : -1

    return (
        <div className="border-t border-[var(--app-divider)] px-3 py-3">
            <div className="mb-3">
                <h3 className="text-[var(--app-fg)]">{t('settings.chat.composerToolbar.title')}</h3>
                <p className="mt-0.5 text-xs text-[var(--app-hint)]">{t('settings.chat.composerToolbar.description')}</p>
            </div>
            <SettingsChoiceGroup
                label={t('settings.chat.composerToolbar.layout')}
                value={layout.mode}
                columns={4}
                options={([
                    ['left', 'settings.chat.composerToolbar.layout.left'],
                    ['center', 'settings.chat.composerToolbar.layout.center'],
                    ['right', 'settings.chat.composerToolbar.layout.right'],
                    ['split', 'settings.chat.composerToolbar.layout.split'],
                ] as const).map(([value, labelKey]) => ({ value, label: t(labelKey) }))}
                onChange={setMode}
            />

            <div className="mt-3 flex items-center justify-between gap-3 px-3">
                <div>
                    <h4 className="text-[var(--app-fg)]">{t('settings.chat.composerToolbar.order')}</h4>
                    <p className="mt-0.5 text-xs text-[var(--app-hint)]">{t('settings.chat.composerToolbar.previewHint')}</p>
                </div>
                <button type="button" onClick={resetLayout} className="shrink-0 text-sm text-[var(--app-link)] hover:underline">{t('settings.chat.composerToolbar.reset')}</button>
            </div>

            <div className="mt-2 rounded-[24px] bg-[var(--app-composer-bg,var(--app-subtle-bg))] px-3 pb-2 pt-3 shadow-sm ring-1 ring-[var(--app-border)]">
                <div className="mb-2 px-1 text-sm text-[var(--app-hint)]">{t('misc.typeAMessage')}</div>
                <div className="flex items-center gap-1">
                    <div className="min-w-0 flex-1 overflow-x-auto">
                        {layout.mode === 'split' ? (
                            <div className="flex min-w-full items-center gap-1">
                                {renderGroup('left', layout.left, 'justify-start', false)}
                                <span className="min-w-2 flex-1" aria-hidden="true" />
                                {renderGroup('right', layout.right, 'justify-end', false)}
                            </div>
                        ) : renderGroup('left', singleItems, singleAlignment, true)}
                    </div>
                    <span className="ml-1" title={t('composer.send')}><ComposerSendButtonPreview /></span>
                </div>
            </div>
            {selectedItem && selectedIndex >= 0 ? (
                <div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-[var(--app-subtle-bg)] px-3 py-2 text-sm">
                    <span className="min-w-0 truncate text-[var(--app-hint)]">{t(ITEM_LABEL_KEYS[selectedItem])}</span>
                    <span className="flex shrink-0 items-center gap-1">
                        <button
                            type="button"
                            disabled={selectedIndex === 0}
                            aria-label={t('settings.chat.composerToolbar.moveEarlier')}
                            title={t('settings.chat.composerToolbar.moveEarlier')}
                            onClick={() => moveItemByOffset(selectedItem, selectedGroup, selectedIndex, -1)}
                            className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-[var(--app-bg)] disabled:opacity-35"
                        >
                            ←
                        </button>
                        <button
                            type="button"
                            disabled={selectedIndex === selectedItems.length - 1}
                            aria-label={t('settings.chat.composerToolbar.moveLater')}
                            title={t('settings.chat.composerToolbar.moveLater')}
                            onClick={() => moveItemByOffset(selectedItem, selectedGroup, selectedIndex, 1)}
                            className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-[var(--app-bg)] disabled:opacity-35"
                        >
                            →
                        </button>
                        {layout.mode === 'split' ? (
                            <button
                                type="button"
                                aria-label={selectedGroup === 'left' ? t('settings.chat.composerToolbar.moveRight') : t('settings.chat.composerToolbar.moveLeft')}
                                title={selectedGroup === 'left' ? t('settings.chat.composerToolbar.moveRight') : t('settings.chat.composerToolbar.moveLeft')}
                                onClick={() => setLayout(moveComposerToolbarItem(layout, selectedItem, selectedGroup === 'left' ? 'right' : 'left', selectedGroup === 'left' ? layout.right.length : layout.left.length))}
                                className="ml-1 rounded-lg px-2.5 py-1.5 text-xs text-[var(--app-link)] hover:bg-[var(--app-bg)]"
                            >
                                {selectedGroup === 'left' ? t('settings.chat.composerToolbar.rightGroup') : t('settings.chat.composerToolbar.leftGroup')}
                            </button>
                        ) : null}
                    </span>
                </div>
            ) : null}
        </div>
    )
}
