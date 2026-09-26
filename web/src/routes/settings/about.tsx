import { PROTOCOL_VERSION } from '@hapi/protocol'
import { getVisibleReleaseNotes, RELEASE_NOTES } from '@/lib/releaseNotes'
import { useTranslation } from '@/lib/use-translation'
import { ChevronRightIcon, SettingsPageContent, SettingsRow, SettingsSection } from '@/components/settings/SettingsPrimitives'

export default function SettingsAboutPage() {
    const { t, locale } = useTranslation()
    const visibleReleaseNotes = getVisibleReleaseNotes(__APP_VERSION__, RELEASE_NOTES)
    const dateFormatter = new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
    })

    return (
        <SettingsPageContent description={t('settings.about.description')}>
            <SettingsSection>
                <SettingsRow label={t('settings.about.website')} trailing={
                    <a href="https://hapi.run" target="_blank" rel="noopener noreferrer" className="text-[var(--app-link)] hover:underline">hapi.run</a>
                } />
                <SettingsRow label={t('settings.about.appVersion')} trailing={<span className="text-[var(--app-hint)]">{__APP_VERSION__}</span>} />
                <SettingsRow label={t('settings.about.protocolVersion')} trailing={<span className="text-[var(--app-hint)]">{PROTOCOL_VERSION}</span>} />
            </SettingsSection>
            <SettingsSection
                title={t('settings.about.releaseNotes.title')}
                description={t('settings.about.releaseNotes.description')}
            >
                {visibleReleaseNotes.map((release, index) => (
                    <details key={release.version} open={index === 0} className="group">
                        <summary className="flex cursor-pointer list-none items-start gap-3 px-3 py-3 text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] [&::-webkit-details-marker]:hidden">
                            <span className="min-w-0 flex-1">
                                <a
                                    href={release.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    aria-label={t('settings.about.releaseNotes.openRelease', { version: release.version })}
                                    onClick={(event) => event.stopPropagation()}
                                    className="inline-block text-sm font-medium text-[var(--app-link)] hover:underline"
                                >
                                    v{release.version}
                                </a>
                                <time dateTime={release.date} className="mt-0.5 block text-xs text-[var(--app-hint)]">
                                    {t('settings.about.releaseNotes.released')} {dateFormatter.format(new Date(release.date + 'T00:00:00Z'))}
                                </time>
                            </span>
                            <ChevronRightIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--app-hint)] transition-transform group-open:rotate-90" />
                        </summary>
                        <div className="border-t border-[var(--app-divider)] px-3 py-3">
                            {release.summary ? (
                                <p className="mb-4 rounded-lg bg-[var(--app-subtle-bg)] px-3 py-2.5 text-sm leading-relaxed text-[var(--app-hint)]"><span className="relative -top-0.5 mr-0.5 inline-block translate-y-[0.5px] align-middle leading-none sm:hidden" aria-hidden="true">🌟</span><span className="relative -top-0.5 mr-0.5 hidden translate-y-[0.5px] align-middle leading-none sm:inline-block sm:-translate-y-[0.5px]" aria-hidden="true">⭐</span> {release.summary[locale]}</p>
                            ) : null}
                            <div className="space-y-4">
                                {release.groups.map((releaseGroup, groupIndex) => (
                                    <section key={groupIndex}>
                                        <div className="mb-2 flex flex-wrap items-center gap-1.5">
                                            <h3 className="text-sm font-semibold text-[var(--app-fg)]">{releaseGroup.title[locale]}</h3>
                                        </div>
                                        <ul className="space-y-2 text-sm leading-relaxed text-[var(--app-fg)]">
                                            {releaseGroup.changes.map((change, changeIndex) => (
                                                <li key={changeIndex}>
                                                    <span className={change.kind === 'feature'
                                                        ? 'relative -top-[1.5px] mr-1.5 inline-flex items-center rounded-md border border-sky-500/30 bg-sky-500/10 px-1.5 py-1 align-middle text-[11px] font-medium leading-none text-sky-700 dark:text-sky-300'
                                                        : change.kind === 'fix'
                                                            ? 'relative -top-[1.5px] mr-1.5 inline-flex items-center rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-1 align-middle text-[11px] font-medium leading-none text-emerald-700 dark:text-emerald-300'
                                                            : 'relative -top-[1.5px] mr-1.5 inline-flex items-center rounded-md border border-slate-400/30 bg-slate-400/10 px-1.5 py-1 align-middle text-[11px] font-medium leading-none text-slate-600 dark:text-slate-300'}>
                                                        <span className="relative top-px sm:top-[0.5px]">{t('settings.about.releaseNotes.kind.' + change.kind)}</span>
                                                    </span>
                                                    {change.text[locale]}
                                                </li>
                                            ))}
                                        </ul>
                                    </section>
                                ))}
                            </div>
                        </div>
                    </details>
                ))}
            </SettingsSection>
        </SettingsPageContent>
    )
}
