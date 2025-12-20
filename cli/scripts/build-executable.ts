import { dirname, isAbsolute, join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_TARGETS = [
    'bun-darwin-x64',
    'bun-darwin-arm64',
    'bun-linux-x64',
    'bun-linux-arm64',
    'bun-windows-x64',
    'bun-windows-arm64'
];
const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux', 'windows']);
const SUPPORTED_ARCHES = new Set(['x64', 'arm64']);

function getArg(args: string[], name: string): string | undefined {
    const idx = args.indexOf(name);
    if (idx === -1 || idx + 1 >= args.length) {
        return undefined;
    }
    return args[idx + 1];
}

function resolveHostPlatform(): string {
    if (process.platform === 'win32') {
        return 'windows';
    }
    if (process.platform === 'darwin' || process.platform === 'linux') {
        return process.platform;
    }
    throw new Error(`Unsupported host platform: ${process.platform}`);
}

function resolveHostArch(): string {
    if (SUPPORTED_ARCHES.has(process.arch)) {
        return process.arch;
    }
    throw new Error(`Unsupported host arch: ${process.arch}`);
}

function resolveTarget(target?: string): string {
    if (!target) {
        return `bun-${resolveHostPlatform()}-${resolveHostArch()}`;
    }

    const parts = target.split('-');
    if (parts.length < 2 || parts.length > 3 || parts[0] !== 'bun') {
        throw new Error(`Invalid target: ${target}`);
    }

    const platformPart = parts[1];
    if (!SUPPORTED_PLATFORMS.has(platformPart)) {
        throw new Error(`Unsupported platform in target: ${target}`);
    }

    const archPart = parts[2] ?? resolveHostArch();
    if (!SUPPORTED_ARCHES.has(archPart)) {
        throw new Error(`Unsupported arch in target: ${target}`);
    }

    return `bun-${platformPart}-${archPart}`;
}

function parseTarget(target: string): { platform: string; arch: string } {
    const parts = target.split('-');
    if (parts.length !== 3 || parts[0] !== 'bun') {
        throw new Error(`Invalid target: ${target}`);
    }

    const platformPart = parts[1];
    const archPart = parts[2];

    if (!SUPPORTED_PLATFORMS.has(platformPart)) {
        throw new Error(`Unsupported platform in target: ${target}`);
    }

    if (!SUPPORTED_ARCHES.has(archPart)) {
        throw new Error(`Unsupported arch in target: ${target}`);
    }

    return {
        platform: platformPart === 'windows' ? 'win32' : platformPart,
        arch: archPart
    };
}

function getFeatureFlag(platform: string, arch: string): string {
    const platformToken = platform === 'win32' ? 'WIN32' : platform.toUpperCase();
    return `HAPI_TARGET_${platformToken}_${arch.toUpperCase()}`;
}

function getPlatformDir(platform: string, arch: string): string {
    if (platform === 'darwin') {
        return arch === 'arm64' ? 'arm64-darwin' : 'x64-darwin';
    }

    if (platform === 'linux') {
        return arch === 'arm64' ? 'arm64-linux' : 'x64-linux';
    }

    if (platform === 'win32') {
        if (arch !== 'x64') {
            throw new Error('Windows arm64 archives are missing; add arm64 tool archives before building.');
        }
        return 'x64-win32';
    }

    throw new Error(`Unsupported platform: ${platform}`);
}

function assertArchivesExist(projectRoot: string, platform: string, arch: string): void {
    const platformDir = getPlatformDir(platform, arch);
    const archives = [
        join(projectRoot, 'tools', 'archives', `difftastic-${platformDir}.tar.gz`),
        join(projectRoot, 'tools', 'archives', `ripgrep-${platformDir}.tar.gz`)
    ];

    for (const archive of archives) {
        if (!existsSync(archive)) {
            throw new Error(`Missing archive: ${archive}`);
        }
    }
}

function resolveOutdir(projectRoot: string, outdir: string): string {
    if (isAbsolute(outdir)) {
        return outdir;
    }
    return join(projectRoot, outdir);
}

async function buildTarget(projectRoot: string, target: string, outdir: string, name: string): Promise<void> {
    const { platform, arch } = parseTarget(target);
    assertArchivesExist(projectRoot, platform, arch);
    const outputName = platform === 'win32' ? `${name}.exe` : name;
    const outfile = join(outdir, target, outputName);
    mkdirSync(dirname(outfile), { recursive: true });
    const featureFlag = getFeatureFlag(platform, arch);

    const cmd = [
        process.execPath,
        'build',
        '--compile',
        `--feature=${featureFlag}`,
        `--target=${target}`,
        `--outfile=${outfile}`,
        join(projectRoot, 'src', 'bootstrap.ts')
    ];

    console.log(`[build:exe] ${cmd.join(' ')}`);

    const proc = Bun.spawn({
        cmd,
        env: process.env,
        stdout: 'inherit',
        stderr: 'inherit',
        cwd: projectRoot
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
        throw new Error(`Build failed for target ${target} (exit ${exitCode})`);
    }
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const target = getArg(args, '--target');
    const outdirArg = getArg(args, '--outdir') ?? 'dist-exe';
    const name = getArg(args, '--name') ?? 'hapi';
    const buildAll = args.includes('--all');

    if (args.includes('--target') && !target) {
        console.error('Usage: bun run scripts/build-executable.ts [--target <bun-platform[-arch]>] [--outdir dist-exe] [--name hapi]');
        console.error('   or: bun run scripts/build-executable.ts --all [--outdir dist-exe] [--name hapi]');
        process.exit(1);
    }

    if (!buildAll && !target) {
        console.log('[build:exe] No --target provided; defaulting to host platform + arch.');
    }

    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const projectRoot = join(scriptDir, '..');
    const outdir = resolveOutdir(projectRoot, outdirArg);
    const resolvedTarget = buildAll ? undefined : resolveTarget(target);
    const targets = buildAll ? DEFAULT_TARGETS : [resolvedTarget!];

    for (const targetName of targets) {
        await buildTarget(projectRoot, targetName, outdir, name);
    }
}

main().catch((error) => {
    console.error(`[build:exe] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});
