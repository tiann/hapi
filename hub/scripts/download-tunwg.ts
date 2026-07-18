/**
 * Download pinned tunwg binaries for all platforms, or only the host with --host.
 *
 * Every existing and downloaded artifact is SHA-256 verified before use. New
 * bytes are installed through a same-directory atomic rename so a failed
 * download cannot replace the last known file.
 */

import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TUNWG_LICENSE, selectTunwgReleases } from './tunwgTargets';

type FetchImplementation = (input: string, init?: RequestInit) => Promise<Response>;

export type InstallVerifiedArtifactOptions = {
    url: string;
    sha256: string;
    destPath: string;
    executable: boolean;
    fetchImpl?: FetchImplementation;
    renameImpl?: (oldPath: string, newPath: string) => Promise<void>;
    log?: (message: string) => void;
};

function digestSha256(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

async function readSha256(path: string): Promise<string | null> {
    try {
        return digestSha256(await readFile(path));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

function assertSha256(value: string): void {
    if (!/^[a-f0-9]{64}$/.test(value)) {
        throw new Error(`Invalid SHA-256 digest: ${value}`);
    }
}

export function getTunwgToolsDir(moduleUrl = import.meta.url): string {
    const scriptDir = dirname(fileURLToPath(moduleUrl));
    return join(scriptDir, '..', 'tools', 'tunwg');
}

export function getTunwgArtifactFilename(target: string): string {
    return `tunwg-${target}${target.includes('win32') ? '.exe' : ''}`;
}

export async function installVerifiedArtifact(
    options: InstallVerifiedArtifactOptions,
): Promise<'reused' | 'installed'> {
    assertSha256(options.sha256);
    const log = options.log ?? console.log;
    const mode = options.executable ? 0o755 : 0o644;
    const existingSha256 = await readSha256(options.destPath);
    if (existingSha256 === options.sha256) {
        await chmod(options.destPath, mode);
        log(`Reusing ${basename(options.destPath)} (SHA-256 verified)`);
        return 'reused';
    }

    log(`Downloading ${options.url}...`);
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(options.url, { redirect: 'follow' });
    if (!response.ok) {
        throw new Error(`Failed to download ${options.url}: ${response.status} ${response.statusText}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    const actualSha256 = digestSha256(bytes);
    if (actualSha256 !== options.sha256) {
        throw new Error(
            `Checksum mismatch for ${options.url}: expected ${options.sha256}, actual ${actualSha256}`,
        );
    }

    const directory = dirname(options.destPath);
    await mkdir(directory, { recursive: true });
    const temporary = join(
        directory,
        `.${basename(options.destPath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
        handle = await open(temporary, 'wx', mode);
        await handle.writeFile(bytes);
        await handle.chmod(mode);
        await handle.sync();
        await handle.close();
        handle = null;
        // Node/libuv maps rename to MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)
        // on Windows, preserving replace-by-rename semantics without an unsafe
        // remove-then-rename gap.
        await (options.renameImpl ?? rename)(temporary, options.destPath);
    } finally {
        if (handle) await handle.close();
        await rm(temporary, { force: true });
    }

    log(`  -> ${options.destPath} (${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB, SHA-256 verified)`);
    return 'installed';
}

export async function downloadTunwgArtifacts(options: {
    args?: string[];
    platform?: NodeJS.Platform;
    arch?: NodeJS.Architecture;
    toolsDir?: string;
    fetchImpl?: FetchImplementation;
    log?: (message: string) => void;
} = {}): Promise<void> {
    const args = options.args ?? process.argv.slice(2);
    const platform = options.platform ?? process.platform;
    const arch = options.arch ?? process.arch;
    const toolsDir = options.toolsDir ?? getTunwgToolsDir();
    const log = options.log ?? console.log;

    for (const [target, release] of selectTunwgReleases(args, platform, arch)) {
        const filename = getTunwgArtifactFilename(target);
        await installVerifiedArtifact({
            ...release,
            destPath: join(toolsDir, filename),
            executable: !target.includes('win32'),
            fetchImpl: options.fetchImpl,
            log,
        });
    }

    await installVerifiedArtifact({
        ...TUNWG_LICENSE,
        destPath: join(toolsDir, 'LICENSE'),
        executable: false,
        fetchImpl: options.fetchImpl,
        log,
    });
}

async function main(): Promise<void> {
    console.log('Preparing pinned tunwg artifacts...\n');
    await downloadTunwgArtifacts();
    console.log('\nDone!');
}

if (import.meta.main) {
    main().catch((error) => {
        console.error('Error:', error);
        process.exitCode = 1;
    });
}
