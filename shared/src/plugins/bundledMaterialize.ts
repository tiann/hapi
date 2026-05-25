import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { HAPI_PLUGIN_MANIFEST_FILE, type PluginManifestLite } from './manifest'

export type BundledPluginFile = {
    path: string
    content: string
}

export type BundledPlugin = {
    manifest: PluginManifestLite
    files: BundledPluginFile[]
}

function expandHomePath(path: string): string {
    return path.replace(/^~(?=$|[/\\])/, homedir())
}

function isPathInside(parentPath: string, childPath: string): boolean {
    const rel = relative(parentPath, childPath)
    return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel))
}

function isEnoent(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function titleCase(value: string): string {
    return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`
}

async function ensureDirectory(path: string, label: string): Promise<void> {
    try {
        const stats = await lstat(path)
        if (stats.isSymbolicLink()) {
            throw new Error(`Refusing to use ${label} symbolic link: ${path}`)
        }
        if (!stats.isDirectory()) {
            throw new Error(`Refusing to use ${label} non-directory: ${path}`)
        }
        return
    } catch (error) {
        if (!isEnoent(error)) {
            throw error
        }
    }

    await mkdir(path, { recursive: true, mode: 0o700 })
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) {
        throw new Error(`Refusing to use ${label} symbolic link: ${path}`)
    }
    if (!stats.isDirectory()) {
        throw new Error(`Refusing to use ${label} non-directory: ${path}`)
    }
}

async function writeFileIfChanged(path: string, content: string, label: string): Promise<void> {
    try {
        const stats = await lstat(path)
        if (stats.isSymbolicLink()) {
            throw new Error(`Refusing to overwrite ${label} symlink: ${path}`)
        }
        if (stats.isFile()) {
            const current = await readFile(path, 'utf8')
            if (current === content) {
                return
            }
        }
    } catch (error) {
        if (!isEnoent(error)) {
            throw error
        }
    }
    await writeFile(path, content, 'utf8')
}

export function getBundledPluginsRoot(hapiHome: string, directoryName: string): string {
    return join(expandHomePath(hapiHome), directoryName)
}

export async function materializeBundledPlugins(options: {
    root: string
    plugins: BundledPlugin[]
    label: string
    pruneExtraneous?: boolean
    skipExisting?: boolean
}): Promise<string> {
    const root = resolve(expandHomePath(options.root))
    await ensureDirectory(root, `${options.label} root`)
    if (options.pruneExtraneous !== false) {
        const allowedIds = new Set(options.plugins.map((plugin) => plugin.manifest.id))
        for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
            if (!allowedIds.has(entry.name)) {
                await rm(join(root, entry.name), { recursive: true, force: true })
            }
        }
    }

    for (const plugin of options.plugins) {
        const pluginRoot = join(root, plugin.manifest.id)
        if (options.skipExisting) {
            try {
                const stats = await lstat(pluginRoot)
                if (stats.isSymbolicLink()) {
                    throw new Error(`Refusing to use ${options.label} symbolic link: ${pluginRoot}`)
                }
                if (!stats.isDirectory()) {
                    throw new Error(`Refusing to use ${options.label} non-directory: ${pluginRoot}`)
                }
                continue
            } catch (error) {
                if (!isEnoent(error)) {
                    throw error
                }
            }
        }
        await ensureDirectory(pluginRoot, `${options.label} plugin directory for ${plugin.manifest.id}`)
        await writeFileIfChanged(join(pluginRoot, HAPI_PLUGIN_MANIFEST_FILE), `${JSON.stringify(plugin.manifest, null, 2)}\n`, options.label)
        for (const file of plugin.files) {
            const filePath = resolve(pluginRoot, file.path)
            if (!isPathInside(resolve(pluginRoot), filePath)) {
                throw new Error(`${titleCase(options.label)} file path escapes plugin root: ${file.path}`)
            }
            await ensureDirectory(dirname(filePath), `${options.label} file directory for ${plugin.manifest.id}`)
            await writeFileIfChanged(filePath, file.content, options.label)
        }
    }

    return root
}

export async function prepareBundledPlugins(options: {
    hapiHome: string
    directoryName: string
    plugins: BundledPlugin[]
    label: string
}): Promise<string> {
    return await materializeBundledPlugins({
        root: getBundledPluginsRoot(options.hapiHome, options.directoryName),
        plugins: options.plugins,
        label: options.label
    })
}
