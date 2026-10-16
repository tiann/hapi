import {
    getSettingsFile,
    readSettingsOrThrow,
    updateSettings,
    type Settings
} from './settings'

/**
 * Hub-persisted opt-in for per-turn session title updates. Default is off
 * (undefined / false). Env `HAPI_AUTO_TITLE_PER_TURN` on the CLI process
 * remains an escape hatch and is resolved client-side.
 */
export function isAutoTitlePerTurnSettingEnabled(settings: Settings): boolean {
    return settings.autoTitlePerTurn === true
}

export async function readAutoTitlePerTurnEnabled(dataDir: string): Promise<boolean> {
    const settings = await readSettingsOrThrow(getSettingsFile(dataDir))
    return isAutoTitlePerTurnSettingEnabled(settings)
}

export async function writeAutoTitlePerTurnEnabled(
    dataDir: string,
    enabled: boolean
): Promise<boolean> {
    return updateSettings(getSettingsFile(dataDir), (current) => {
        const settings = {
            ...current,
            autoTitlePerTurn: enabled
        }
        return {
            settings,
            result: settings.autoTitlePerTurn === true
        }
    })
}
