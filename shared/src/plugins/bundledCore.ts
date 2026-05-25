import { PluginManifestLiteSchema } from './manifest'
import { getBundledPluginsRoot, materializeBundledPlugins, prepareBundledPlugins, type BundledPlugin } from './bundledMaterialize'
import { embeddedPluginMarketplaceSources } from './marketplaceSources.generated'
import { getPluginStateFile, getUserPluginsDir, PluginStateLockError, readPluginState, writePluginState } from './foundation'

export const HAPI_BUNDLED_FIRST_PARTY_PLUGINS_DIR = 'bundled-first-party-plugins'
export const HAPI_SCHEDULE_SEND_PLUGIN_ID = 'com.hapi.schedule-send'
export const HAPI_SERVERCHAN_NOTIFIER_PLUGIN_ID = 'com.hapi.serverchan-notifier'
export const HAPI_RUNNER_LAUNCH_PRESETS_PLUGIN_ID = 'com.hapi.runner-launch-presets'

export type BundledFirstPartyPlugin = BundledPlugin

function bundledPluginFromEmbeddedSource(pluginId: string): BundledFirstPartyPlugin {
    const source = embeddedPluginMarketplaceSources[pluginId]
    if (!source) {
        throw new Error(`Missing embedded first-party plugin source for ${pluginId}`)
    }
    const manifestFile = source.files.find((file) => file.path === 'hapi.plugin.json')
    if (!manifestFile) {
        throw new Error(`Missing embedded first-party plugin manifest for ${pluginId}`)
    }
    const manifest = PluginManifestLiteSchema.parse(JSON.parse(Buffer.from(manifestFile.contentBase64, 'base64').toString('utf8')) as unknown)
    return {
        manifest,
        files: source.files
            .filter((file) => file.path !== 'hapi.plugin.json')
            .map((file) => ({
                path: file.path,
                content: Buffer.from(file.contentBase64, 'base64').toString('utf8')
            }))
    }
}

export const bundledFirstPartyPlugins: BundledFirstPartyPlugin[] = [
    HAPI_SCHEDULE_SEND_PLUGIN_ID,
    HAPI_SERVERCHAN_NOTIFIER_PLUGIN_ID,
    HAPI_RUNNER_LAUNCH_PRESETS_PLUGIN_ID
].map((pluginId) => bundledPluginFromEmbeddedSource(pluginId))

export const defaultInstalledBundledPluginIds = [HAPI_SCHEDULE_SEND_PLUGIN_ID]
export const defaultEnabledBundledPluginIds = [HAPI_SCHEDULE_SEND_PLUGIN_ID]
export const defaultEnabledBundledRunnerPluginIds = bundledFirstPartyPlugins
    .filter((plugin) => defaultEnabledBundledPluginIds.includes(plugin.manifest.id) && Boolean(plugin.manifest.runtimes?.runner))
    .map((plugin) => plugin.manifest.id)

export function getBundledFirstPartyPluginsRoot(hapiHome: string): string {
    return getBundledPluginsRoot(hapiHome, HAPI_BUNDLED_FIRST_PARTY_PLUGINS_DIR)
}

export async function prepareBundledFirstPartyPlugins(hapiHome: string): Promise<string> {
    return await prepareBundledPlugins({
        hapiHome,
        directoryName: HAPI_BUNDLED_FIRST_PARTY_PLUGINS_DIR,
        plugins: bundledFirstPartyPlugins,
        label: 'bundled first-party'
    })
}

export async function seedDefaultFirstPartyPluginsAsUserPlugins(hapiHome: string): Promise<void> {
    const statePath = getPluginStateFile(hapiHome)
    const stateResult = await readPluginState(statePath)
    if (stateResult.parseError) return

    const seededDefaultPluginIds = stateResult.state.seededDefaultPluginIds ?? {}
    const defaultInstalled = new Set(defaultInstalledBundledPluginIds)
    const pluginsToSeed = bundledFirstPartyPlugins
        .filter((plugin) => defaultInstalled.has(plugin.manifest.id))
        .filter((plugin) => seededDefaultPluginIds[plugin.manifest.id] !== true)
    if (pluginsToSeed.length === 0) return

    await materializeBundledPlugins({
        root: getUserPluginsDir(hapiHome),
        plugins: pluginsToSeed,
        label: 'default first-party plugin seed',
        pruneExtraneous: false,
        skipExisting: true
    })

    const latestStateResult = await readPluginState(statePath)
    if (latestStateResult.parseError) return

    const nextState = latestStateResult.state
    const defaultEnabled = new Set(defaultEnabledBundledPluginIds)
    nextState.seededDefaultPluginIds = { ...(nextState.seededDefaultPluginIds ?? {}) }
    for (const plugin of pluginsToSeed) {
        const pluginId = plugin.manifest.id
        nextState.seededDefaultPluginIds[pluginId] = true
        const previous = nextState.enabled[pluginId]
        nextState.enabled[pluginId] = {
            ...(previous ?? {}),
            enabled: previous?.enabled ?? defaultEnabled.has(pluginId),
            install: previous?.install ?? {
                sourceType: 'user-home',
                version: plugin.manifest.version
            }
        }
    }
    try {
        await writePluginState(statePath, nextState)
    } catch (error) {
        if (error instanceof PluginStateLockError) return
        throw error
    }
}
