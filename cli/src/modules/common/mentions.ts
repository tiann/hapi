import { readFile } from 'node:fs/promises'
import { listEnabledCodexPluginInstallations, resolveRealFileInside } from './codexPlugins'

export interface MentionSummary {
    name: string
    label: string
    insertText: string
    description?: string
    kind: 'app' | 'plugin'
    pluginName: string
}

export interface ListMentionsRequest {
    agent?: string
}

export interface ListMentionsResponse {
    success: boolean
    mentions?: MentionSummary[]
    error?: string
}

interface PluginManifest {
    name?: string
    description?: string
    apps?: string
}

interface AppManifest {
    apps?: Record<string, { id?: string }>
}

async function readJsonFile<T>(path: string): Promise<T | null> {
    const raw = await readFile(path, 'utf-8').catch(() => null)
    if (!raw) {
        return null
    }
    try {
        return JSON.parse(raw) as T
    } catch {
        return null
    }
}

export async function listMentions(request: ListMentionsRequest = {}): Promise<MentionSummary[]> {
    if (request.agent !== 'codex') {
        return []
    }

    const installations = await listEnabledCodexPluginInstallations()
    const mentionEntries = await Promise.all(installations.map(async (installation) => {
        const manifestPath = await resolveRealFileInside(installation.installPath, '.codex-plugin', 'plugin.json')
        const manifest = manifestPath ? await readJsonFile<PluginManifest>(manifestPath) : null
        const description = manifest?.description
        const appManifestPath = typeof manifest?.apps === 'string'
            ? await resolveRealFileInside(installation.installPath, manifest.apps)
            : null
        const appManifest = appManifestPath ? await readJsonFile<AppManifest>(appManifestPath) : null
        const appEntries: MentionSummary[] = Object.entries(appManifest?.apps ?? {})
            .flatMap(([appName, app]) => {
                if (!app?.id) {
                    return []
                }
                return [{
                    name: appName,
                    label: `@${appName}`,
                    insertText: `[$${appName}](app://${app.id})`,
                    description,
                    kind: 'app' as const,
                    pluginName: installation.pluginName,
                } satisfies MentionSummary]
            })

        if (appEntries.length > 0) {
            return appEntries
        }

        return [{
            name: installation.pluginName,
            label: `@${installation.pluginName}`,
            insertText: `@${installation.pluginName}`,
            description,
            kind: 'plugin' as const,
            pluginName: installation.pluginName,
        } satisfies MentionSummary]
    }))

    return mentionEntries
        .flat()
        .sort((a, b) => a.label.localeCompare(b.label))
}
