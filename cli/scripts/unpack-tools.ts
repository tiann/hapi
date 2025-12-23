import { chmodSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { arch, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';

export function getPlatformDir(): string {
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

export function getToolsDir(): string {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    return resolve(scriptDir, '..', 'tools');
}

function areToolsUnpacked(toolsDir: string): boolean {
    const unpackedPath = join(toolsDir, 'unpacked');
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

function unpackArchive(archivePath: string, destDir: string): void {
    if (!existsSync(destDir)) {
        mkdirSync(destDir, { recursive: true });
    }

    tar.extract({
        file: archivePath,
        cwd: destDir,
        sync: true,
        gzip: true,
        preserveMode: true,
        preserveOwner: false
    });
}

export function unpackTools(): { success: true; alreadyUnpacked: boolean } {
    const platformDir = getPlatformDir();
    const toolsDir = getToolsDir();
    const archivesDir = join(toolsDir, 'archives');
    const unpackedPath = join(toolsDir, 'unpacked');

    if (areToolsUnpacked(toolsDir)) {
        console.log(`Tools already unpacked for ${platformDir}`);
        return { success: true, alreadyUnpacked: true };
    }

    console.log(`Unpacking tools for ${platformDir}...`);
    if (!existsSync(unpackedPath)) {
        mkdirSync(unpackedPath, { recursive: true });
    }

    const archives = [
        `difftastic-${platformDir}.tar.gz`,
        `ripgrep-${platformDir}.tar.gz`
    ];

    for (const archiveName of archives) {
        const archivePath = join(archivesDir, archiveName);
        if (!existsSync(archivePath)) {
            throw new Error(`Archive not found: ${archivePath}`);
        }
        unpackArchive(archivePath, unpackedPath);
    }

    if (platform() !== 'win32') {
        const files = readdirSync(unpackedPath);
        for (const file of files) {
            const filePath = join(unpackedPath, file);
            const stats = statSync(filePath);
            if (stats.isFile() && !file.endsWith('.node')) {
                chmodSync(filePath, 0o755);
            }
        }
    }

    console.log(`Tools unpacked successfully to ${unpackedPath}`);
    return { success: true, alreadyUnpacked: false };
}

if (import.meta.main) {
    try {
        unpackTools();
        process.exit(0);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Failed to unpack tools:', message);
        process.exit(1);
    }
}
