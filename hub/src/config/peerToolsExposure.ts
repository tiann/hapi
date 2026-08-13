import { getSettingsFile, readSettingsOrThrow, type Settings } from './settings'

/** Peer tools are exposed by default; this is exposure control, not REST authorization. */
export function isPeerToolsEnabledSetting(settings: Settings): boolean {
    return settings.peerToolsEnabled !== false
}

/** Read the hub peer-tool exposure setting, defaulting old settings to enabled. */
export async function readPeerToolsEnabled(dataDir: string): Promise<boolean> {
    return isPeerToolsEnabledSetting(await readSettingsOrThrow(getSettingsFile(dataDir)))
}
