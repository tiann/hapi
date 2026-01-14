import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { arch, platform } from 'node:os';
import * as tar from 'tar';
import packageJson from '../../package.json';
import type { EmbeddedAsset } from '#embedded-assets';
import { isBunCompiled, runtimePath } from '@/projectPath';

const RUNTIME_MARKER = '.runtime-version';

function ensureDirectory(path: string): void {
    mkdirSync(path, { recursive: true });
}

const bunRuntime = (globalThis as typeof globalThis & {
    Bun?: { file: (source: string | URL) => { arrayBuffer: () => Promise<ArrayBuffer> } };
}).Bun;

async function copyAssetFile(asset: EmbeddedAsset, targetPath: string): Promise<void> {
    ensureDirectory(dirname(targetPath));
    if (bunRuntime) {
        const data = await bunRuntime.file(asset.sourcePath).arrayBuffer();
        writeFileSync(targetPath, Buffer.from(data));
        return;
    }

    copyFileSync(asset.sourcePath, targetPath);
    try {
        const stats = statSync(asset.sourcePath);
        chmodSync(targetPath, stats.mode);
    } catch {
        // Best-effort; permission adjustments are not critical.
    }
}

function getPlatformDir(): string {
    const platformName = platform();
    const archName = arch();

    if (platformName === 'darwin') {
        if (archName === 'arm64') return 'arm64-darwin';
        if (archName === 'x64') return 'x64-darwin';
    } else if (platformName === 'linux') {
        if (archName === 'arm64') return 'arm64-linux';
        if (archName === 'x64') return 'x64-linux';
    } else if (platformName === 'win32') {
        if (archName === 'x64') return 'x64-win32';
    }

    throw new Error(`Unsupported platform: ${archName}-${platformName}`);
}

function areToolsUnpacked(unpackedPath: string): boolean {
    if (!existsSync(unpackedPath)) {
        return false;
    }

    const isWin = platform() === 'win32';
    const difftBinary = isWin ? 'difft.exe' : 'difft';
    const rgBinary = isWin ? 'rg.exe' : 'rg';

    const expectedFiles = [
        join(unpackedPath, difftBinary),
        join(unpackedPath, rgBinary)
    ];

    return expectedFiles.every((file) => existsSync(file));
}

function isTunwgReady(runtimeRoot: string): boolean {
    const isWin = platform() === 'win32';
    const tunwgBinary = isWin ? 'tunwg.exe' : 'tunwg';
    const tunwgPath = join(runtimeRoot, 'tools', 'tunwg', tunwgBinary);
    return existsSync(tunwgPath);
}

function ensureTunwgExecutable(runtimeRoot: string): void {
    if (platform() === 'win32') {
        return;
    }

    const tunwgPath = join(runtimeRoot, 'tools', 'tunwg', 'tunwg');
    if (existsSync(tunwgPath)) {
        chmodSync(tunwgPath, 0o755);
    }
}

function unpackTools(runtimeRoot: string): void {
    const platformDir = getPlatformDir();
    const toolsDir = join(runtimeRoot, 'tools');
    const archivesDir = join(toolsDir, 'archives');
    const unpackedPath = join(toolsDir, 'unpacked');

    if (areToolsUnpacked(unpackedPath)) {
        return;
    }

    rmSync(unpackedPath, { recursive: true, force: true });
    ensureDirectory(unpackedPath);

    const archives = [
        `difftastic-${platformDir}.tar.gz`,
        `ripgrep-${platformDir}.tar.gz`
    ];

    for (const archiveName of archives) {
        const archivePath = join(archivesDir, archiveName);
        if (!existsSync(archivePath)) {
            throw new Error(`Archive not found: ${archivePath}`);
        }
        tar.extract({
            file: archivePath,
            cwd: unpackedPath,
            sync: true,
            preserveOwner: false
        });
    }

    if (platform() !== 'win32') {
        const files = readdirSync(unpackedPath);
        for (const file of files) {
            if (file.endsWith('.node')) {
                continue;
            }
            const filePath = join(unpackedPath, file);
            const stats = statSync(filePath);
            if (stats.isFile()) {
                chmodSync(filePath, 0o755);
            }
        }
    }
}

function runtimeAssetsReady(runtimeRoot: string): boolean {
    return areToolsUnpacked(join(runtimeRoot, 'tools', 'unpacked')) && isTunwgReady(runtimeRoot);
}

export async function ensureRuntimeAssets(): Promise<void> {
    if (!isBunCompiled()) {
        return;
    }

    const { loadEmbeddedAssets } = await import('#embedded-assets');
    const runtimeRoot = runtimePath();
    const markerPath = join(runtimeRoot, RUNTIME_MARKER);
    if (existsSync(markerPath)) {
        const markerVersion = readFileSync(markerPath, 'utf-8').trim();
        if (markerVersion === packageJson.version && runtimeAssetsReady(runtimeRoot)) {
            return;
        }
    }

    ensureDirectory(runtimeRoot);

    const embeddedAssets = await loadEmbeddedAssets();

    for (const asset of embeddedAssets) {
        const targetPath = join(runtimeRoot, asset.relativePath);
        await copyAssetFile(asset, targetPath);
    }

    unpackTools(runtimeRoot);
    ensureTunwgExecutable(runtimeRoot);
    writeFileSync(markerPath, packageJson.version, 'utf-8');
}

export function getTunwgPath(): string {
    const isWin = platform() === 'win32';
    const tunwgBinary = isWin ? 'tunwg.exe' : 'tunwg';

    if (isBunCompiled()) {
        return join(runtimePath(), 'tools', 'tunwg', tunwgBinary);
    }

    // Development mode: use downloaded binary from server/tools/tunwg
    const platformDir = getPlatformDir();
    const devBinaryName = isWin ? `tunwg-${platformDir}.exe` : `tunwg-${platformDir}`;
    return join(__dirname, '..', '..', '..', 'server', 'tools', 'tunwg', devBinaryName);
}
