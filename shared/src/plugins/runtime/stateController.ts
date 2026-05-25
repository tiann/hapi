import { rm, realpath } from 'node:fs/promises'
import type { PluginInstallLocalRequest, PluginInstallPackageRequest } from '../admin'
import type { PluginInstallMetadata, PluginStateFile } from '../state'
import { assertPluginConfigSafeForPersistence } from '../config'
import {
    getPluginStateFile,
    getUserPluginsDir,
    installPluginFromDirectory,
    installPluginFromPackage,
    readPluginState,
    resolvePluginScopedConfig,
    setPluginScopedConfig,
    writePluginState,
    type DiscoveredPluginRecord,
    type PluginDirectoryInstallResult,
    type PluginPackageInstallResult
} from '../foundation'
import { listPluginLocalDirectory, isPathInside } from './fsHelpers'

export type PluginRuntimeStateControllerOptions = {
    hapiHome: string
    configScope(pluginId: string): string
    defaultEnabledPluginIds?: () => readonly string[]
    enableDefaultOnConfigUpdate?: boolean
    displayId(record: DiscoveredPluginRecord): string
}

export type PluginRuntimeInstallSourceType = Extract<PluginInstallMetadata['sourceType'], 'hub-local-path' | 'runner-local-path'>

export type PluginDeletedRecord = {
    pluginId: string
    rootPath: string
}

export class PluginRuntimeStateController {
    constructor(private readonly options: PluginRuntimeStateControllerOptions) {}

    async readWritableState(): Promise<PluginStateFile> {
        const stateResult = await readPluginState(getPluginStateFile(this.options.hapiHome))
        if (stateResult.parseError) {
            throw new Error(`Cannot update plugins.json while it is invalid: ${stateResult.parseError}`)
        }
        return stateResult.state
    }

    applyScopedRuntimeConfig(records: DiscoveredPluginRecord[], state: PluginStateFile): DiscoveredPluginRecord[] {
        return records.map((record) => {
            if (!record.manifest || record.status === 'blocked') {
                return record
            }
            const resolved = resolvePluginScopedConfig(state.enabled[record.manifest.id], this.options.configScope(record.manifest.id))
            const baseRecord = { ...record }
            delete baseRecord.config
            delete baseRecord.configUpdatedAt
            delete baseRecord.configSource
            return {
                ...baseRecord,
                ...(resolved.config ? { config: resolved.config } : {}),
                ...(resolved.updatedAt ? { configUpdatedAt: resolved.updatedAt } : {}),
                configSource: resolved.source
            }
        })
    }

    async enablePluginState(
        id: string,
        config: Record<string, unknown> | undefined,
        findRecord: (id: string) => Promise<DiscoveredPluginRecord | null>
    ): Promise<string> {
        const state = await this.readWritableState()
        const record = await findRecord(id)
        if (!record) throw new Error(`Plugin ${id} was not found.`)
        assertDiscoveredRecordCanBeEnabled(record, id)
        assertPluginConfigSafeForPersistence(config, record.manifest.permissions?.secrets ?? [], record.manifest.id)
        const previous = state.enabled[record.manifest.id]
        state.enabled[record.manifest.id] = config
            ? { ...setPluginScopedConfig(previous, this.options.configScope(record.manifest.id), config), enabled: true }
            : { ...previous, enabled: true }
        await this.writeState(state)
        return record.manifest.id
    }

    async disablePluginState(
        id: string,
        findRecord: (id: string) => Promise<DiscoveredPluginRecord | null>
    ): Promise<string> {
        const state = await this.readWritableState()
        const record = await findRecord(id)
        const pluginId = record?.manifest?.id ?? id
        const previous = state.enabled[pluginId]
        state.enabled[pluginId] = {
            ...previous,
            enabled: false
        }
        await this.writeState(state)
        return pluginId
    }

    async updatePluginConfigState(
        id: string,
        config: Record<string, unknown>,
        findRecord: (id: string) => Promise<DiscoveredPluginRecord | null>
    ): Promise<string> {
        const state = await this.readWritableState()
        const record = await findRecord(id)
        if (!record) throw new Error(`Plugin ${id} was not found.`)
        assertDiscoveredRecordCanBeEnabled(record, id)
        assertPluginConfigSafeForPersistence(config, record.manifest.permissions?.secrets ?? [], record.manifest.id)
        const previous = state.enabled[record.manifest.id]
        const nextEntry = setPluginScopedConfig(previous, this.options.configScope(record.manifest.id), config)
        state.enabled[record.manifest.id] = previous === undefined
            && this.options.enableDefaultOnConfigUpdate === true
            && (this.options.defaultEnabledPluginIds?.() ?? []).includes(record.manifest.id)
            ? { ...nextEntry, enabled: true }
            : nextEntry
        await this.writeState(state)
        return record.manifest.id
    }

    async installLocalPlugin(
        options: Pick<PluginInstallLocalRequest, 'sourcePath' | 'overwrite' | 'enable'>,
        sourceType: PluginRuntimeInstallSourceType
    ): Promise<PluginDirectoryInstallResult> {
        const install = await installPluginFromDirectory({
            hapiHome: this.options.hapiHome,
            sourcePath: options.sourcePath,
            overwrite: options.overwrite === true
        })
        const pluginId = install.record.manifest!.id
        await this.recordInstallState(pluginId, {
            sourceType,
            sourcePath: install.sourcePath,
            version: install.record.manifest!.version
        }, options.enable === true)
        return install
    }

    async installPluginPackage(options: PluginInstallPackageRequest): Promise<PluginPackageInstallResult> {
        const install = await installPluginFromPackage({
            hapiHome: this.options.hapiHome,
            filename: options.filename,
            contentBase64: options.contentBase64,
            checksum: options.checksum,
            format: options.format,
            manifest: options.manifest,
            overwrite: options.overwrite === true
        })
        const pluginId = install.record.manifest!.id
        const marketplaceInstall = options.installSource?.type === 'marketplace'
        await this.recordInstallState(pluginId, {
            sourceType: marketplaceInstall ? 'marketplace' : 'uploaded-package',
            checksum: install.checksum,
            packageFormat: install.packageFormat,
            version: install.record.manifest!.version,
            ...(marketplaceInstall ? {
                marketplace: {
                    sourceUrl: options.installSource!.sourceUrl,
                    pluginId: options.installSource!.pluginId,
                    repo: options.installSource!.repo,
                    version: options.installSource!.version,
                    distribution: options.installSource!.distribution ?? (options.installSource!.sourcePath ? 'hapi-source' : 'package'),
                    ...(options.installSource!.assetUrl ? { assetUrl: options.installSource!.assetUrl } : {}),
                    ...(options.installSource!.sourcePath ? { sourcePath: options.installSource!.sourcePath } : {}),
                    checksum: install.checksum
                }
            } : {})
        }, options.enable === true)
        return install
    }

    async listLocalDirectory(path?: string) {
        return await listPluginLocalDirectory(path, this.options.hapiHome)
    }

    async deleteUserHomePlugin(
        id: string,
        findRecord: (id: string) => Promise<DiscoveredPluginRecord | null>,
        disposeActive: (pluginId: string) => Promise<void>
    ): Promise<PluginDeletedRecord> {
        const record = await findRecord(id)
        if (!record) {
            throw new Error(`Plugin ${id} was not found.`)
        }
        if (record.source !== 'user-home') {
            throw new Error(`Plugin ${id} cannot be deleted because it is from ${record.source}. Only user-home plugins can be deleted.`)
        }

        const pluginId = this.options.displayId(record)
        const statePluginId = record.status === 'blocked' ? undefined : record.manifest?.id
        const userPluginsDir = getUserPluginsDir(this.options.hapiHome)
        const [userPluginsRealPath, rootRealPath] = await Promise.all([
            realpath(userPluginsDir),
            realpath(record.rootPath)
        ])
        if (!isPathInside(userPluginsRealPath, rootRealPath)) {
            throw new Error(`Plugin ${pluginId} cannot be deleted because its path is outside the user plugin directory.`)
        }

        const nextState = statePluginId ? await this.readWritableState() : null
        if (nextState && statePluginId) {
            delete nextState.enabled[statePluginId]
            await this.writeState(nextState)
            await disposeActive(statePluginId)
        }
        await rm(rootRealPath, { recursive: true, force: true })
        return {
            pluginId,
            rootPath: rootRealPath
        }
    }

    private async recordInstallState(pluginId: string, metadata: Omit<PluginInstallMetadata, 'installedAt' | 'updatedAt'>, enable: boolean): Promise<void> {
        const state = await this.readWritableState()
        const previous = state.enabled[pluginId]
        const now = Date.now()
        state.enabled[pluginId] = {
            enabled: enable ? true : previous?.enabled === true,
            ...(previous?.config ? { config: previous.config } : {}),
            ...(previous?.configUpdatedAt ? { configUpdatedAt: previous.configUpdatedAt } : {}),
            ...(previous?.scopedConfig ? { scopedConfig: previous.scopedConfig } : {}),
            install: {
                ...metadata,
                installedAt: previous?.install?.installedAt ?? now,
                updatedAt: now
            }
        }
        await this.writeState(state)
    }

    private async writeState(state: PluginStateFile): Promise<void> {
        await writePluginState(getPluginStateFile(this.options.hapiHome), state)
    }
}

export function assertDiscoveredRecordCanBeEnabled(
    record: DiscoveredPluginRecord,
    id: string
): asserts record is DiscoveredPluginRecord & { manifest: NonNullable<DiscoveredPluginRecord['manifest']> } {
    if (!record.manifest) {
        throw new Error(`Plugin ${id} was not found.`)
    }
    if (record.status !== 'validated') {
        throw new Error(`Plugin ${record.manifest.id} cannot be enabled while status is ${record.status}.`)
    }
}
