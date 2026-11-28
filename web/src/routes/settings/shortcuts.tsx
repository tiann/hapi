import { useState, type KeyboardEvent } from 'react'
import { SettingsPageContent, SettingsRow, SettingsSection } from '@/components/settings/SettingsPrimitives'
import { setChatShortcuts, useChatShortcuts } from '@/hooks/useChatShortcuts'
import {
    CHAT_SHORTCUT_ACTIONS, DEFAULT_CHAT_SHORTCUTS, formatChatShortcut, getChatShortcut,
    isAssignableChatShortcut, isChatShortcutEvent, isComposerOnlyChatShortcut, type ChatShortcutAction,
} from '@/lib/chatShortcuts'
import { useTranslation } from '@/lib/use-translation'

const buttonClass = 'min-h-9 rounded-md border border-[var(--app-border)] px-2 py-1 text-sm hover:bg-[var(--app-subtle-bg)]'

export default function SettingsShortcutsPage() {
    const { t } = useTranslation()
    const shortcuts = useChatShortcuts()
    const [recording, setRecording] = useState<ChatShortcutAction | null>(null)
    const [error, setError] = useState('')
    const actionLabel = (action: ChatShortcutAction) => t(`settings.shortcuts.action.${action}`)

    function stopRecording() {
        setRecording(null)
        setError('')
    }

    function recordShortcut(event: KeyboardEvent<HTMLButtonElement>, action: ChatShortcutAction) {
        if (recording !== action || !isChatShortcutEvent(event.nativeEvent)) return
        if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) return
        event.preventDefault()
        event.stopPropagation()
        if (event.key === 'Escape') {
            stopRecording()
            return
        }
        if (['Alt', 'Control', 'Meta', 'Shift'].includes(event.key)) return

        const shortcut = getChatShortcut(event)
        if (!isAssignableChatShortcut(shortcut)) {
            setError(t('settings.shortcuts.invalid'))
            return
        }
        const conflict = CHAT_SHORTCUT_ACTIONS.find((other) => other !== action && shortcuts[other] === shortcut)
        if (conflict) {
            setError(t('settings.shortcuts.conflict', { action: actionLabel(conflict) }))
            return
        }
        setChatShortcuts({ ...shortcuts, [action]: shortcut })
        stopRecording()
    }

    return (
        <SettingsPageContent>
            <SettingsSection title={t('settings.chat.title')}>
                {CHAT_SHORTCUT_ACTIONS.map((action) => {
                    const shortcut = shortcuts[action]
                    const active = recording === action
                    const value = active ? t('settings.shortcuts.record') : shortcut ? formatChatShortcut(shortcut) : t('settings.shortcuts.unassigned')
                    const effortDescription = action === 'effort' || action === 'effortDecrease' || action === 'effortIncrease'
                        ? t(`settings.shortcuts.description.${action}`)
                        : ''
                    const scopeDescription = shortcut && isComposerOnlyChatShortcut(shortcut) ? t('settings.shortcuts.composerOnly') : ''
                    return (
                        <SettingsRow key={action} label={actionLabel(action)} description={[effortDescription, scopeDescription].filter(Boolean).join(' ')} trailing={(
                            <div className="flex flex-wrap justify-end gap-1.5">
                                <button
                                    type="button"
                                    className={`${buttonClass} ${active ? 'border-[var(--app-link)] text-[var(--app-link)]' : ''}`}
                                    aria-label={`${actionLabel(action)} · ${value}`}
                                    aria-pressed={active}
                                    onClick={(event) => {
                                        if (active) {
                                            stopRecording()
                                            return
                                        }
                                        event.currentTarget.focus()
                                        setError('')
                                        setRecording(action)
                                    }}
                                    onBlur={stopRecording}
                                    onKeyDown={(event) => recordShortcut(event, action)}
                                >
                                    {shortcut && !active ? <kbd>{value}</kbd> : value}
                                </button>
                                <button
                                    type="button"
                                    className={`${buttonClass} disabled:opacity-40`}
                                    aria-label={`${t('settings.shortcuts.clear')} · ${actionLabel(action)}`}
                                    disabled={!shortcut}
                                    onClick={() => setChatShortcuts({ ...shortcuts, [action]: null })}
                                >
                                    {t('settings.shortcuts.clear')}
                                </button>
                            </div>
                        )}>
                            {active && error ? <p role="alert" className="mt-1 text-xs text-[var(--app-danger)]">{error}</p> : null}
                        </SettingsRow>
                    )
                })}
            </SettingsSection>
            <button type="button" className={buttonClass} onClick={() => setChatShortcuts(DEFAULT_CHAT_SHORTCUTS)}>
                {t('settings.shortcuts.reset')}
            </button>
        </SettingsPageContent>
    )
}
