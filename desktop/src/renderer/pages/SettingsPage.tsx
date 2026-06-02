import { useEffect, useState } from 'react'
import type { LauncherConfig, Locale, RuntimeStatus } from '../../shared'
import type { Dictionary } from '../i18n'

type Props = {
    config: LauncherConfig
    runtimeStatus: RuntimeStatus
    dict: Dictionary
    onSave: (config: LauncherConfig) => Promise<void>
}

export function SettingsPage({ config, runtimeStatus, dict, onSave }: Props) {
    const [draft, setDraft] = useState(config)
    const isServiceSettingDisabled = runtimeStatus !== 'stopped' && runtimeStatus !== 'error'

    useEffect(() => {
        setDraft(config)
    }, [config])

    const addDirectory = async () => {
        const selected = await window.hapiDesktop.chooseDirectory()
        if (!selected) {
            return
        }
        setDraft((current) => ({
            ...current,
            workspaceRoots: Array.from(new Set([...current.workspaceRoots, selected]))
        }))
    }

    const removeDirectory = (path: string) => {
        setDraft((current) => ({
            ...current,
            workspaceRoots: current.workspaceRoots.filter((item) => item !== path)
        }))
    }

    const save = async () => {
        await onSave(draft)
    }

    return (
        <div className="page-content settings-page">
            <section className="card settings-section">
                <h2>{dict.settingsPage.directories}</h2>
                <p>{dict.settingsPage.directoriesHint}</p>
                <div className="directory-list">
                    {draft.workspaceRoots.map((root) => (
                        <div className="directory-row" key={root}>
                            <span>{root}</span>
                            <button className="danger-button" type="button" disabled={isServiceSettingDisabled} onClick={() => removeDirectory(root)}>{dict.settingsPage.remove}</button>
                        </div>
                    ))}
                </div>
                <button className="secondary-button" type="button" disabled={isServiceSettingDisabled} onClick={() => void addDirectory()}>{dict.settingsPage.addDirectory}</button>
            </section>

            <section className="card settings-section hub-section">
                <h2>{dict.settingsPage.hub}</h2>
                <label className="field-row">
                    <span>{dict.settingsPage.port}</span>
                    <input disabled={isServiceSettingDisabled} type="number" min={1} max={65535} value={draft.hubPort} onChange={(event) => setDraft({ ...draft, hubPort: Number(event.target.value) })} />
                </label>
                <label className="field-row relay-row">
                    <span>{dict.settingsPage.relay}</span>
                    <input disabled={isServiceSettingDisabled} type="checkbox" checked={draft.relayEnabled} onChange={(event) => setDraft({ ...draft, relayEnabled: event.target.checked })} />
                </label>
            </section>

            <section className="card settings-section language-section">
                <h2>{dict.settingsPage.language}</h2>
                <div className="language-options">
                    <button className={draft.locale === 'zh-CN' ? 'language-option active' : 'language-option'} type="button" onClick={() => setDraft({ ...draft, locale: 'zh-CN' })}>简体中文</button>
                    <button className={draft.locale === 'en' ? 'language-option active' : 'language-option'} type="button" onClick={() => setDraft({ ...draft, locale: 'en' as Locale })}>English</button>
                </div>
            </section>

            <div className="settings-actions">
                <button className="secondary-button" type="button" onClick={() => setDraft(config)}>{dict.settingsPage.cancel}</button>
                <button className="primary-button compact" type="button" onClick={() => void save()}>{dict.settingsPage.save}</button>
            </div>
        </div>
    )
}
