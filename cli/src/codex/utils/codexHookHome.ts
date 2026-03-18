import { configuration } from '@/configuration';
import { buildHookForwarderCommand, buildSessionStartHookSettings } from '@/modules/common/hooks/generateHookSettings';
import { logger } from '@/ui/logger';
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

type CreateCodexHookHomeOptions = {
    port: number;
    token: string;
};

export type CodexHookHome = {
    codexHomeDir: string;
    cleanup: () => Promise<void>;
};

const LOG_LABEL = 'codex-hook-home';
const SHARED_ROOT_DIRECTORIES = [
    'sessions',
    'archived_sessions',
    'shell_snapshots',
    'memories',
    'rules',
    '.tmp'
] as const;
const SHARED_ROOT_FILES = [
    'history.jsonl',
    'auth.json',
    'config.toml',
    'session_index.jsonl'
] as const;

function resolveBaseCodexHomeDir(): string {
    return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

async function mirrorCodexFile(sourcePath: string, targetPath: string): Promise<void> {
    try {
        await link(sourcePath, targetPath);
        return;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        logger.debug(`[${LOG_LABEL}] Hard link failed for ${sourcePath}: ${code ?? error}`);
    }

    try {
        await symlink(sourcePath, targetPath, 'file');
        return;
    } catch (error) {
        throw new Error(
            `Failed to mirror CODEX_HOME file without copy: ${sourcePath} -> ${targetPath}: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }
}

async function mirrorCodexHome(sourceDir: string, targetDir: string): Promise<void> {
    let entries;
    try {
        entries = await readdir(sourceDir, { withFileTypes: true, encoding: 'utf8' });
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
            logger.debug(`[${LOG_LABEL}] Base CODEX_HOME missing, starting from empty dir: ${sourceDir}`);
            return;
        }
        throw error;
    }

    for (const entry of entries) {
        if (entry.name === 'hooks.json') {
            continue;
        }

        const sourcePath = join(sourceDir, entry.name);
        const targetPath = join(targetDir, entry.name);

        let sourceStats: Awaited<ReturnType<typeof stat>>;
        try {
            sourceStats = await stat(sourcePath);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') {
                continue;
            }
            throw error;
        }

        if (sourceStats.isDirectory()) {
            const linkType = process.platform === 'win32' ? 'junction' : 'dir';
            await symlink(sourcePath, targetPath, linkType);
            continue;
        }

        if (sourceStats.isFile()) {
            await mirrorCodexFile(sourcePath, targetPath);
            continue;
        }

        logger.debug(`[${LOG_LABEL}] Skipping unsupported CODEX_HOME entry: ${sourcePath}`);
    }
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

async function ensureSharedRootEntries(baseCodexHomeDir: string, codexHomeDir: string): Promise<void> {
    for (const dirName of SHARED_ROOT_DIRECTORIES) {
        const overlayPath = join(codexHomeDir, dirName);
        if (await pathExists(overlayPath)) {
            continue;
        }

        const basePath = join(baseCodexHomeDir, dirName);
        await mkdir(basePath, { recursive: true });
        const linkType = process.platform === 'win32' ? 'junction' : 'dir';
        await symlink(basePath, overlayPath, linkType);
    }

    for (const fileName of SHARED_ROOT_FILES) {
        const overlayPath = join(codexHomeDir, fileName);
        if (await pathExists(overlayPath)) {
            continue;
        }

        const basePath = join(baseCodexHomeDir, fileName);
        if (!await pathExists(basePath)) {
            await writeFile(basePath, '');
        }
        await mirrorCodexFile(basePath, overlayPath);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

async function buildMergedHooksFile(baseCodexHomeDir: string, hookCommand: string): Promise<ReturnType<typeof buildSessionStartHookSettings>> {
    const baseHooksPath = join(baseCodexHomeDir, 'hooks.json');
    const injectedSettings = buildSessionStartHookSettings(hookCommand);

    let rawBaseHooks: string;
    try {
        rawBaseHooks = await readFile(baseHooksPath, 'utf-8');
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
            return injectedSettings;
        }
        throw error;
    }

    const parsed = JSON.parse(rawBaseHooks) as unknown;
    if (!isRecord(parsed)) {
        throw new Error(`Invalid hooks.json in ${baseHooksPath}: expected object`);
    }

    const hooks = isRecord(parsed.hooks) ? parsed.hooks : {};
    const existingSessionStart = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];

    return {
        ...injectedSettings,
        ...parsed,
        hooks: {
            ...hooks,
            SessionStart: [
                ...existingSessionStart,
                ...injectedSettings.hooks.SessionStart
            ]
        }
    };
}

export async function createCodexHookHome(options: CreateCodexHookHomeOptions): Promise<CodexHookHome> {
    const tempRoot = join(configuration.happyHomeDir, 'tmp');
    await mkdir(tempRoot, { recursive: true });

    const baseCodexHomeDir = resolveBaseCodexHomeDir();
    const codexHomeDir = await mkdtemp(join(tempRoot, 'codex-home-'));

    await mirrorCodexHome(baseCodexHomeDir, codexHomeDir);
    await ensureSharedRootEntries(baseCodexHomeDir, codexHomeDir);

    const hookCommand = buildHookForwarderCommand(options.port, options.token);
    const hooks = await buildMergedHooksFile(baseCodexHomeDir, hookCommand);
    const hooksPath = join(codexHomeDir, 'hooks.json');
    await writeFile(hooksPath, JSON.stringify(hooks, null, 4));

    logger.debug(`[${LOG_LABEL}] Created CODEX_HOME overlay`, {
        baseCodexHomeDir,
        codexHomeDir,
        hooksPath
    });

    return {
        codexHomeDir,
        cleanup: async () => {
            await rm(codexHomeDir, { recursive: true, force: true });
            logger.debug(`[${LOG_LABEL}] Removed CODEX_HOME overlay: ${codexHomeDir}`);
        }
    };
}
