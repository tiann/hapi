import {
    getSettingsFile,
    readSettingsOrThrow,
    updateSettings,
    type Settings
} from './settings'

/**
 * Hub-persisted opt-in to show AGENT_NOTIFY_SUMMARY in chat UI.
 * Default is off (undefined / false): render/copy strip the footer;
 * store, parse, FCM, and ledger capture keep the raw line.
 */
export function isSessionSummaryInChatSettingEnabled(settings: Settings): boolean {
    return settings.sessionSummaryInChat === true
}

export async function readSessionSummaryInChatEnabled(dataDir: string): Promise<boolean> {
    const settings = await readSettingsOrThrow(getSettingsFile(dataDir))
    return isSessionSummaryInChatSettingEnabled(settings)
}

export async function writeSessionSummaryInChatEnabled(
    dataDir: string,
    enabled: boolean
): Promise<boolean> {
    return updateSettings(getSettingsFile(dataDir), (current) => {
        const settings = {
            ...current,
            sessionSummaryInChat: enabled
        }
        return {
            settings,
            result: settings.sessionSummaryInChat === true
        }
    })
}
