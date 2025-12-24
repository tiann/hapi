/**
 * Prepare npm platform packages for publishing.
 *
 * This script:
 * 1. Reads the version from cli/package.json
 * 2. Generates package.json for each platform package
 * 3. Copies binaries from dist-exe to npm package directories
 * 4. Updates optionalDependencies versions in main package.json
 *
 * Run after `bun run build:exe:all`
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// Platform configurations
// Maps npm platform name to build target info
const PLATFORMS = [
    {
        name: 'darwin-arm64',
        os: 'darwin',
        cpu: 'arm64',
        buildTarget: 'bun-darwin-arm64',
        binName: 'hapi'
    },
    {
        name: 'darwin-x64',
        os: 'darwin',
        cpu: 'x64',
        buildTarget: 'bun-darwin-x64',
        binName: 'hapi'
    },
    {
        name: 'linux-arm64',
        os: 'linux',
        cpu: 'arm64',
        buildTarget: 'bun-linux-arm64',
        binName: 'hapi'
    },
    {
        name: 'linux-x64',
        os: 'linux',
        cpu: 'x64',
        buildTarget: 'bun-linux-x64',
        binName: 'hapi'
    },
    {
        name: 'win32-x64',
        os: 'win32',
        cpu: 'x64',
        buildTarget: 'bun-windows-x64',
        binName: 'hapi.exe'
    }
] as const;

interface MainPackageJson {
    version: string;
    license?: string;
    repository?: {
        type: string;
        url: string;
    };
}

async function readMainPackageJson(): Promise<MainPackageJson> {
    const pkgPath = join(projectRoot, 'package.json');
    const content = await Bun.file(pkgPath).text();
    return JSON.parse(content);
}

function generatePlatformPackageJson(
    platform: typeof PLATFORMS[number],
    mainPkg: MainPackageJson
): object {
    return {
        name: `@twsxtd/hapi-${platform.name}`,
        version: mainPkg.version,
        description: `hapi binary for ${platform.os} ${platform.cpu}`,
        os: [platform.os],
        cpu: [platform.cpu],
        bin: {
            hapi: `bin/${platform.binName}`
        },
        files: [`bin/${platform.binName}`],
        license: mainPkg.license ?? 'MIT',
        repository: mainPkg.repository
    };
}

async function preparePlatform(
    platform: typeof PLATFORMS[number],
    mainPkg: MainPackageJson,
    distExeDir: string,
    npmDir: string
): Promise<void> {
    const platformDir = join(npmDir, platform.name);
    const binDir = join(platformDir, 'bin');

    // Ensure bin directory exists
    mkdirSync(binDir, { recursive: true });

    // Generate package.json
    const pkgJson = generatePlatformPackageJson(platform, mainPkg);
    const pkgJsonPath = join(platformDir, 'package.json');
    writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 4) + '\n');
    console.log(`Generated: ${pkgJsonPath}`);

    // Copy binary
    const srcBin = join(distExeDir, platform.buildTarget, platform.binName);
    const destBin = join(binDir, platform.binName);

    if (!existsSync(srcBin)) {
        console.warn(`Warning: Binary not found: ${srcBin}`);
        console.warn(`  Run 'bun run build:exe:all' first to build binaries.`);
        return;
    }

    copyFileSync(srcBin, destBin);
    console.log(`Copied: ${srcBin} -> ${destBin}`);
}

function updateMainPackageOptionalDeps(version: string): void {
    const pkgPath = join(projectRoot, 'package.json');
    const content = readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(content);

    // Update optionalDependencies versions
    if (!pkg.optionalDependencies) {
        pkg.optionalDependencies = {};
    }

    for (const platform of PLATFORMS) {
        pkg.optionalDependencies[`@twsxtd/hapi-${platform.name}`] = version;
    }

    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`Updated optionalDependencies in package.json to version ${version}`);
}

async function main(): Promise<void> {
    console.log('Preparing npm platform packages...\n');

    const mainPkg = await readMainPackageJson();
    console.log(`Version: ${mainPkg.version}\n`);

    // Update optionalDependencies in main package.json
    updateMainPackageOptionalDeps(mainPkg.version);

    const distExeDir = join(projectRoot, 'dist-exe');
    const npmDir = join(projectRoot, 'npm');

    let hasErrors = false;

    for (const platform of PLATFORMS) {
        try {
            await preparePlatform(platform, mainPkg, distExeDir, npmDir);
        } catch (error) {
            console.error(`Error preparing ${platform.name}:`, error);
            hasErrors = true;
        }
    }

    console.log('\nDone!');

    if (hasErrors) {
        process.exit(1);
    }
}

main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
