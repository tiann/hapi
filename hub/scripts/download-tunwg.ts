/**
 * Download tunwg binaries for all platforms
 *
 * Downloads pinned pre-built tunwg binaries from GitHub releases.
 * Output directory: shared/tools/tunwg/
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const isWindows = process.platform === 'win32';
const TUNWG_VERSION = 'v26.01.13+359bfa2';
const TUNWG_RELEASE_BASE_URL = `https://github.com/tiann/tunwg/releases/download/${encodeURIComponent(TUNWG_VERSION)}`;

const TUNWG_RELEASES: Record<string, { asset: string; sha256: string }> = {
    'x64-linux': {
        asset: 'tunwg',
        sha256: 'a61c96c0b11e28cfc1904ad04779670e90133bae4e9bd17b979dad7de8319238'
    },
    'arm64-linux': {
        asset: 'tunwg-arm64',
        sha256: '19be6977f84acb5a4ceac96deb829f967a188b7975fa67f2d174acf745d70891'
    },
    'x64-darwin': {
        asset: 'tunwg-darwin',
        sha256: 'e226d325b4fadf43ee7138168b84da239e35c8ed82d4a87f0745f0769ae6b222'
    },
    'arm64-darwin': {
        asset: 'tunwg-darwin-arm64',
        sha256: '70c90b59e1aded850cf3b77d5eb6145302a17a91e7267e2d12a5a675fa1784cd'
    },
    'x64-win32': {
        asset: 'tunwg.exe',
        sha256: 'dd52d035139e27402eadff761dbd1dda70c161551ae2eafcbc3ca0afa77b6f21'
    }
};

const LICENSE_URL = `https://raw.githubusercontent.com/tiann/tunwg/refs/tags/${encodeURIComponent(TUNWG_VERSION)}/LICENSE`;

function sha256(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
}

function verifyBuffer(buffer: Buffer, expectedHash: string, label: string): void {
    const actualHash = sha256(buffer);
    if (actualHash !== expectedHash) {
        throw new Error(`SHA256 mismatch for ${label}: expected ${expectedHash}, got ${actualHash}`);
    }
}

async function downloadFile(url: string, destPath: string, expectedHash?: string): Promise<void> {
    console.log(`Downloading ${url}...`);

    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) {
        throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (expectedHash) {
        verifyBuffer(buffer, expectedHash, url);
    }

    const dirName = dirname(destPath);
    console.log(`  ->mkdirDir ${dirName}`);
    mkdirSync(dirName, { recursive: true });
    writeFileSync(destPath, buffer);

    console.log(`  -> ${destPath} (${(buffer.byteLength / 1024 / 1024).toFixed(2)} MB)`);
}

async function main(): Promise<void> {
    let scriptDir: string;
    if (isWindows) {
        const __filename = fileURLToPath(import.meta.url);
        scriptDir = dirname(__filename);
    } else {
        scriptDir = dirname(new URL(import.meta.url).pathname);
    }
    const toolsDir = join(scriptDir, '..', '..', 'shared', 'tools', 'tunwg');

    console.log('Downloading tunwg binaries...\n');

    console.log(`Pinned version: ${TUNWG_VERSION}\n`);

    // Download all platform binaries
    for (const [platform, release] of Object.entries(TUNWG_RELEASES)) {
        const filename = `tunwg-${platform}${platform.includes('win32') ? '.exe' : ''}`;
        const destPath = join(toolsDir, filename);
        const url = `${TUNWG_RELEASE_BASE_URL}/${release.asset}`;

        if (existsSync(destPath)) {
            verifyBuffer(readFileSync(destPath), release.sha256, destPath);
            console.log(`Skipping ${filename} (already exists and checksum matches)`);
            continue;
        }

        await downloadFile(url, destPath, release.sha256);

        // Make executable on Unix
        if (!platform.includes('win32')) {
            chmodSync(destPath, 0o755);
        }
    }

    // Download LICENSE
    const licensePath = join(toolsDir, 'LICENSE');
    if (!existsSync(licensePath)) {
        await downloadFile(LICENSE_URL, licensePath);
    } else {
        console.log('Skipping LICENSE (already exists)');
    }

    console.log('\nDone!');
}

main().catch((error) => {
    console.error('Error:', error);
    process.exit(1);
});
