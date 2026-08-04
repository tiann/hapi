import {
    getSettingsFile,
    readSettingsOrThrow,
    writeSettings,
    type Settings
} from './settings'

/**
 * Hub-persisted opt-in for AGENT_NOTIFY_SUMMARY prompt injection.
 * Default is off (undefined / false). Env `HAPI_SESSION_SUMMARY_CONTRACT` on
 * the CLI process remains an escape hatch and is resolved client-side.
 */
export function isSessionSummaryContractSettingEnabled(settings: Settings): boolean {
    return settings.sessionSummaryContract === true
}

export async function readSessionSummaryContractEnabled(dataDir: string): Promise<boolean> {
    const settings = await readSettingsOrThrow(getSettingsFile(dataDir))
    return isSessionSummaryContractSettingEnabled(settings)
}

export async function writeSessionSummaryContractEnabled(
    dataDir: string,
    enabled: boolean
): Promise<boolean> {
    const settingsFile = getSettingsFile(dataDir)
    const settings = await readSettingsOrThrow(settingsFile)
    const next: Settings = {
        ...settings,
        sessionSummaryContract: enabled
    }
    await writeSettings(settingsFile, next)
    return enabled
}
