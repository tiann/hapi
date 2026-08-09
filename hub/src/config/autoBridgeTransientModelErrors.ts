import {
    getSettingsFile,
    readSettingsOrThrow,
    updateSettings,
    type Settings
} from './settings'

/**
 * Hub-persisted opt-in for Cursor auto-bridge after transient model errors.
 * Default is off (undefined / false). Applied to CLI processes on session
 * create/get so unattended / restarted sessions honor Settings.
 */
export function isAutoBridgeTransientModelErrorsSettingEnabled(settings: Settings): boolean {
    return settings.autoBridgeTransientModelErrors === true
}

export async function readAutoBridgeTransientModelErrorsEnabled(dataDir: string): Promise<boolean> {
    const settings = await readSettingsOrThrow(getSettingsFile(dataDir))
    return isAutoBridgeTransientModelErrorsSettingEnabled(settings)
}

export async function writeAutoBridgeTransientModelErrorsEnabled(
    dataDir: string,
    enabled: boolean
): Promise<boolean> {
    return updateSettings(getSettingsFile(dataDir), (current) => {
        const settings = {
            ...current,
            autoBridgeTransientModelErrors: enabled
        }
        return {
            settings,
            result: settings.autoBridgeTransientModelErrors === true
        }
    })
}
