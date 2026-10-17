import {
    getSettingsFile,
    readSettingsOrThrow,
    updateSettings,
    type Settings
} from './settings'

/**
 * Hub-persisted opt-out for the peer-session MCP tools (`list_peers` /
 * `inspect_peer` / `ping_peer`). Default is off (tools available). Env
 * `HAPI_DISABLE_PEER_TOOLS` on the CLI process remains a per-runner escape
 * hatch and is resolved client-side.
 */
export function isDisablePeerToolsSettingEnabled(settings: Settings): boolean {
    return settings.disablePeerTools === true
}

export async function readDisablePeerToolsEnabled(dataDir: string): Promise<boolean> {
    const settings = await readSettingsOrThrow(getSettingsFile(dataDir))
    return isDisablePeerToolsSettingEnabled(settings)
}

export async function writeDisablePeerToolsEnabled(
    dataDir: string,
    disabled: boolean
): Promise<boolean> {
    return updateSettings(getSettingsFile(dataDir), (current) => {
        const settings = {
            ...current,
            disablePeerTools: disabled
        }
        return {
            settings,
            result: settings.disablePeerTools === true
        }
    })
}
