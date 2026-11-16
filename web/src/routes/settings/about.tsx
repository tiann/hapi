import { useState, type ChangeEvent } from 'react'
import { PROTOCOL_VERSION } from '@hapi/protocol'
import { useTranslation } from '@/lib/use-translation'
import { downloadBlob } from '@/lib/file-download'
import { exportSettings, importSettings } from '@/lib/settingsTransfer'
import { SettingsPageContent, SettingsRow, SettingsSection } from '@/components/settings/SettingsPrimitives'

const buttonClassName = 'cursor-pointer rounded-lg bg-[var(--app-button)] px-3 py-2 text-sm font-medium text-[var(--app-button-text)]'

export default function SettingsAboutPage() {
    const { t } = useTranslation()
    const [importError, setImportError] = useState(false)

    const handleExport = () => {
        const file = exportSettings()
        const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })
        downloadBlob(`hapi-settings-${file.exportedAt.slice(0, 10)}.json`, blob)
    }

    const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
        const selected = event.target.files?.[0]
        event.target.value = ''
        if (!selected) return
        try {
            importSettings(await selected.text())
        } catch {
            setImportError(true)
            return
        }
        // Hooks cache their values on mount; reload so every setting is re-read.
        window.location.reload()
    }

    return (
        <SettingsPageContent description={t('settings.about.description')}>
            <SettingsSection>
                <SettingsRow label={t('settings.about.website')} trailing={
                    <a href="https://hapi.run" target="_blank" rel="noopener noreferrer" className="text-[var(--app-link)] hover:underline">hapi.run</a>
                } />
                <SettingsRow label={t('settings.about.appVersion')} trailing={<span className="text-[var(--app-hint)]">{__APP_VERSION__}</span>} />
                <SettingsRow label={t('settings.about.protocolVersion')} trailing={<span className="text-[var(--app-hint)]">{PROTOCOL_VERSION}</span>} />
            </SettingsSection>
            <SettingsSection>
                <SettingsRow label={t('settings.about.backup.title')} description={t('settings.about.backup.description')} trailing={
                    <div className="flex gap-2">
                        <button type="button" onClick={handleExport} className={buttonClassName}>
                            {t('settings.about.backup.exportButton')}
                        </button>
                        <label className={`${buttonClassName} focus-within:ring-2 focus-within:ring-[var(--app-link)]`}>
                            {t('settings.about.backup.importButton')}
                            <input type="file" accept="application/json,.json" className="sr-only" onChange={(event) => void handleImport(event)} />
                        </label>
                    </div>
                }>
                    {importError ? <div role="alert" className="mt-0.5 text-xs text-red-600 dark:text-red-400">{t('settings.about.backup.importError')}</div> : null}
                </SettingsRow>
            </SettingsSection>
        </SettingsPageContent>
    )
}
