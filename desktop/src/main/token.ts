import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ConfigStore } from './configStore'

type HapiSettings = {
    cliApiToken?: unknown
}

export async function resolveCliApiToken(configStore: ConfigStore): Promise<string> {
    const settingsToken = await readTokenFromSettings()
    if (settingsToken) {
        return settingsToken
    }

    const config = await configStore.read()
    if (config.launcherToken) {
        return config.launcherToken
    }

    if (process.env.CLI_API_TOKEN) {
        return process.env.CLI_API_TOKEN
    }

    const token = randomBytes(32).toString('base64url')
    await configStore.update((current) => ({ ...current, launcherToken: token }))
    return token
}

async function readTokenFromSettings(): Promise<string | null> {
    const settingsPath = join(homedir(), '.hapi', 'settings.json')
    try {
        const raw = await readFile(settingsPath, 'utf8')
        const settings = JSON.parse(raw) as HapiSettings
        return typeof settings.cliApiToken === 'string' && settings.cliApiToken.length > 0
            ? settings.cliApiToken
            : null
    } catch {
        return null
    }
}
