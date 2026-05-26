export const DEFAULT_MAX_PLUGIN_PACKAGE_BYTES = 25 * 1024 * 1024
export const DEFAULT_MAX_PLUGIN_PACKAGE_STORAGE_BYTES = 256 * 1024 * 1024

export type PluginPackagePayloadLimitOptions = {
    maxPluginPackageBytes?: number
    maxPluginPackageStorageBytes?: number
}

type PluginPackagePayload = {
    contentBase64: string
}

export function pluginPackagePayloadSize(request: PluginPackagePayload): { packageBytes: number; storageBytes: number } {
    return {
        packageBytes: Buffer.byteLength(request.contentBase64, 'base64'),
        storageBytes: Buffer.byteLength(request.contentBase64, 'utf8')
    }
}

export function pluginPackagePayloadIsTooLarge(request: PluginPackagePayload, options: PluginPackagePayloadLimitOptions = {}): boolean {
    const { packageBytes, storageBytes } = pluginPackagePayloadSize(request)
    return packageBytes > (options.maxPluginPackageBytes ?? DEFAULT_MAX_PLUGIN_PACKAGE_BYTES)
        || storageBytes > (options.maxPluginPackageStorageBytes ?? DEFAULT_MAX_PLUGIN_PACKAGE_STORAGE_BYTES)
}
