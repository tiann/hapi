/**
 * Download tunwg binaries for all platforms
 *
 * Downloads pre-built tunwg binaries from GitHub releases.
 * Output directory: server/tools/tunwg/
 */

import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';

const TUNWG_RELEASES: Record<string, string> = {
    'x64-linux': 'https://github.com/tiann/tunwg/releases/latest/download/tunwg',
    'arm64-linux': 'https://github.com/tiann/tunwg/releases/latest/download/tunwg-arm64',
    'x64-darwin': 'https://github.com/tiann/tunwg/releases/latest/download/tunwg-darwin',
    'arm64-darwin': 'https://github.com/tiann/tunwg/releases/latest/download/tunwg-darwin-arm64',
    'x64-win32': 'https://github.com/tiann/tunwg/releases/latest/download/tunwg.exe'
};

const LICENSE_URL = 'https://raw.githubusercontent.com/tiann/tunwg/refs/heads/main/LICENSE';

async function downloadFile(url: string, destPath: string): Promise<void> {
    console.log(`Downloading ${url}...`);

    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) {
        throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, Buffer.from(buffer));

    console.log(`  -> ${destPath} (${(buffer.byteLength / 1024 / 1024).toFixed(2)} MB)`);
}

async function main(): Promise<void> {
    const scriptDir = dirname(new URL(import.meta.url).pathname);
    const toolsDir = join(scriptDir, '..', 'tools', 'tunwg');

    console.log('Downloading tunwg binaries...\n');

    // Download all platform binaries
    for (const [platform, url] of Object.entries(TUNWG_RELEASES)) {
        const filename = `tunwg-${platform}${platform.includes('win32') ? '.exe' : ''}`;
        const destPath = join(toolsDir, filename);

        if (existsSync(destPath)) {
            console.log(`Skipping ${filename} (already exists)`);
            continue;
        }

        await downloadFile(url, destPath);

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
