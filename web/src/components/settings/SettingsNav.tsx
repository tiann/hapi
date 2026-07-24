import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from '@/lib/use-translation'
import { useAppearance } from '@/hooks/useTheme'
import { useFontScale } from '@/hooks/useFontScale'
import { useComposerEnterBehavior } from '@/hooks/useComposerEnterBehavior'
import { settingsCategories } from '@/routes/settings/categories'
import { ChevronRightIcon } from './SettingsPrimitives'

export function SettingsNav(props: { activeId?: string; mobile?: boolean }) {
    const navigate = useNavigate()
    const { t, locale } = useTranslation()
    const { appearance } = useAppearance()
    const { fontScale } = useFontScale()
    const { composerEnterBehavior } = useComposerEnterBehavior()

    const summaries: Record<string, string> = {
        general: locale === 'zh-CN' ? '简体中文' : 'English',
        display: `${t(`settings.display.appearance.${appearance}`)} · ${Math.round(fontScale * 100)}%`,
        chat: t(`settings.chat.enterBehavior.${composerEnterBehavior}`),
        providers: t('settings.providers.summary'),
        voice: t('settings.hub.voice.summary'),
        about: `v${__APP_VERSION__}`,
    }

    return (
        <nav aria-label={t('settings.title')} className={props.mobile ? 'divide-y divide-[var(--app-divider)]' : 'space-y-1 p-3'}>
            {settingsCategories.map((category) => {
                const active = props.activeId === category.id
                return (
                    <button
                        key={category.id}
                        type="button"
                        onClick={() => navigate({ to: category.path })}
                        aria-current={active ? 'page' : undefined}
                        className={props.mobile
                            ? 'flex min-h-16 w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-[var(--app-subtle-bg)]'
                            : `flex w-full items-center rounded-lg px-3 py-2.5 text-left transition-colors ${active ? 'bg-[var(--app-subtle-bg)] text-[var(--app-link)]' : 'text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'}`}
                    >
                        <span className="min-w-0 flex-1">
                            <span className="block font-medium">{t(category.titleKey)}</span>
                            {props.mobile ? <span className="mt-0.5 block truncate text-sm text-[var(--app-hint)]">{summaries[category.id]}</span> : null}
                        </span>
                        {props.mobile ? <ChevronRightIcon className="h-4 w-4 text-[var(--app-hint)]" /> : null}
                    </button>
                )
            })}
        </nav>
    )
}
