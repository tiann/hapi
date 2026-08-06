import {
    getSettingsFile,
    readSettingsOrThrow,
    updateSettings,
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
    return updateSettings(getSettingsFile(dataDir), (current) => {
        const settings = {
            ...current,
            sessionSummaryContract: enabled
        }
        return {
            settings,
            result: settings.sessionSummaryContract === true
        }
    })
}
