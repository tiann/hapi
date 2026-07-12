import { access, readdir, readFile } from 'fs/promises';
import { basename, dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { parse as parseYaml } from 'yaml';

export interface SkillSummary {
    name: string;
    description?: string;
}

export interface ListSkillsRequest {
    flavor?: string;
}

export interface ListSkillsResponse {
    success: boolean;
    skills?: SkillSummary[];
    error?: string;
}

type InstalledPlugin = {
    installPath?: string;
    installedAt?: string;
    lastUpdated?: string;
};

type InstalledPluginsFile = {
    plugins?: Record<string, InstalledPlugin[]>;
};

function getHomeDirectory(): string {
    return process.env.HOME ?? process.env.USERPROFILE ?? homedir();
}

function normalizeFlavor(flavor?: string): string {
    return (flavor ?? 'claude').trim().toLowerCase();
}

function getAgentConfigDir(flavor?: string): string {
    const normalizedFlavor = normalizeFlavor(flavor);
    switch (normalizedFlavor) {
        case 'claude':
            return process.env.CLAUDE_CONFIG_DIR || join(getHomeDirectory(), '.claude');
        case 'codex':
            return process.env.CODEX_HOME || join(getHomeDirectory(), '.codex');
        case 'grok':
            return process.env.GROK_HOME || join(getHomeDirectory(), '.grok');
        default:
            return join(getHomeDirectory(), `.${normalizedFlavor}`);
    }
}

function getUserSkillsRoots(flavor?: string): string[] {
    const home = getHomeDirectory();
    const roots = [join(home, '.agents', 'skills')];
    switch (normalizeFlavor(flavor)) {
        case 'claude':
            roots.push(join(getAgentConfigDir(flavor), 'skills'));
            break;
        case 'codex':
            roots.push(join(getAgentConfigDir(flavor), 'skills'));
            break;
        case 'grok':
            roots.push(join(getAgentConfigDir(flavor), 'skills'));
            break;
    }
    return roots;
}

function getAdminSkillsRoot(): string {
    return join('/etc', 'codex', 'skills');
}

function getProjectSkillsRoots(directory: string, flavor?: string): string[] {
    const roots = [join(directory, '.agents', 'skills')];
    switch (normalizeFlavor(flavor)) {
        case 'claude':
            roots.push(join(directory, '.claude', 'skills'));
            break;
        case 'codex':
            roots.push(join(directory, '.codex', 'skills'));
            break;
        case 'grok':
            roots.push(join(directory, '.grok', 'skills'));
            break;
    }
    return roots;
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

async function listProjectSkillsRoots(workingDirectory?: string, flavor?: string): Promise<string[]> {
    if (!workingDirectory) {
        return [];
    }

    const resolvedWorkingDirectory = resolve(workingDirectory);
    const directories = [resolvedWorkingDirectory];
    let currentDirectory = resolvedWorkingDirectory;

    while (true) {
        if (await pathExists(join(currentDirectory, '.git'))) {
            return directories.flatMap((directory) => getProjectSkillsRoots(directory, flavor));
        }

        const parentDirectory = dirname(currentDirectory);
        if (parentDirectory === currentDirectory) {
            return getProjectSkillsRoots(resolvedWorkingDirectory, flavor);
        }

        currentDirectory = parentDirectory;
        directories.push(currentDirectory);
    }
}

function parseFrontmatter(fileContent: string): { frontmatter?: Record<string, unknown>; body: string } {
    const match = fileContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) {
        return { body: fileContent.trim() };
    }

    const yamlContent = match[1];
    const body = match[2].trim();
    try {
        const parsed = parseYaml(yamlContent) as Record<string, unknown> | null;
        return { frontmatter: parsed ?? undefined, body };
    } catch {
        return { body: fileContent.trim() };
    }
}

function extractSkillSummary(skillDir: string, fileContent: string): SkillSummary | null {
    const parsed = parseFrontmatter(fileContent);
    const nameFromFrontmatter = typeof parsed.frontmatter?.name === 'string' ? parsed.frontmatter.name.trim() : '';
    const name = nameFromFrontmatter || basename(skillDir);
    if (!name) {
        return null;
    }

    const description = typeof parsed.frontmatter?.description === 'string'
        ? parsed.frontmatter.description.trim()
        : undefined;

    return { name, description };
}

async function listTopLevelSkillDirs(skillsRoot: string, options: { includeCodexSystem?: boolean } = {}): Promise<string[]> {
    try {
        const entries = await readdir(skillsRoot, { withFileTypes: true });
        const result: string[] = [];

        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }

            if (entry.name.startsWith('.')) {
                if (options.includeCodexSystem && entry.name === '.system') {
                    const systemEntries = await readdir(join(skillsRoot, entry.name), { withFileTypes: true }).catch(() => []);
                    for (const systemEntry of systemEntries) {
                        if (systemEntry.isDirectory() && !systemEntry.name.startsWith('.')) {
                            result.push(join(skillsRoot, entry.name, systemEntry.name));
                        }
                    }
                }
                continue;
            }

            result.push(join(skillsRoot, entry.name));
        }

        return result;
    } catch {
        return [];
    }
}

async function readSkillsFromDirs(skillDirs: string[]): Promise<SkillSummary[]> {
    const skills = await Promise.all(skillDirs.map(async (dir): Promise<SkillSummary | null> => {
        const filePath = join(dir, 'SKILL.md');
        try {
            const fileContent = await readFile(filePath, 'utf-8');
            return extractSkillSummary(dir, fileContent);
        } catch {
            return null;
        }
    }));

    return skills.filter((skill): skill is SkillSummary => skill !== null);
}

function shouldIncludeCodexSystem(root: string, flavor: string): boolean {
    if (flavor !== 'codex') {
        return false;
    }

    return root.endsWith(join('.codex', 'skills'))
        || root === join(getAgentConfigDir('codex'), 'skills');
}

async function listPluginCacheSkillsRoots(flavor?: string): Promise<string[]> {
    const installedPath = join(getAgentConfigDir(flavor), 'plugins', 'installed_plugins.json');
    let installed: InstalledPluginsFile;

    try {
        installed = JSON.parse(await readFile(installedPath, 'utf-8')) as InstalledPluginsFile;
    } catch {
        return [];
    }

    const getInstallTime = (installation: InstalledPlugin): number => {
        const lastUpdated = Date.parse(installation.lastUpdated ?? '');
        if (Number.isFinite(lastUpdated)) return lastUpdated;
        const installedAt = Date.parse(installation.installedAt ?? '');
        return Number.isFinite(installedAt) ? installedAt : 0;
    };

    return Object.values(installed.plugins ?? {})
        .filter((installations): installations is InstalledPlugin[] => Array.isArray(installations))
        .map((installations) => [...installations]
            .sort((a, b) => getInstallTime(b) - getInstallTime(a))[0]?.installPath)
        .filter((installPath): installPath is string => typeof installPath === 'string' && installPath.length > 0)
        .map((installPath) => join(installPath, 'skills'));
}

export async function listSkills(workingDirectory?: string, options: { flavor?: string } = {}): Promise<SkillSummary[]> {
    const flavor = normalizeFlavor(options.flavor);
    const projectRoots = await listProjectSkillsRoots(workingDirectory, flavor);
    const userRoots = getUserSkillsRoots(flavor);
    const pluginRoots = await listPluginCacheSkillsRoots(flavor);
    const adminRoot = getAdminSkillsRoot();
    const includeAdminRoots = flavor === 'codex';
    const [projectSkillDirs, userSkillDirs, pluginSkillDirs, adminSkillDirs] = await Promise.all([
        Promise.all(projectRoots.map(async (root) => await listTopLevelSkillDirs(root, { includeCodexSystem: shouldIncludeCodexSystem(root, flavor) }))).then((dirs) => dirs.flat()),
        Promise.all(userRoots.map(async (root) => await listTopLevelSkillDirs(root, { includeCodexSystem: shouldIncludeCodexSystem(root, flavor) }))).then((dirs) => dirs.flat()),
        Promise.all(pluginRoots.map(async (root) => await listTopLevelSkillDirs(root, { includeCodexSystem: false }))).then((dirs) => dirs.flat()),
        includeAdminRoots ? listTopLevelSkillDirs(adminRoot, { includeCodexSystem: true }) : [],
    ]);

    const [projectSkills, userSkills, pluginSkills, adminSkills] = await Promise.all([
        readSkillsFromDirs(projectSkillDirs),
        readSkillsFromDirs(userSkillDirs),
        readSkillsFromDirs(pluginSkillDirs),
        readSkillsFromDirs(adminSkillDirs),
    ]);

    const dedupedSkills = new Map<string, SkillSummary>();
    for (const skill of [
        ...projectSkills,
        ...userSkills,
        ...pluginSkills,
        ...adminSkills,
    ]) {
        if (!dedupedSkills.has(skill.name)) {
            dedupedSkills.set(skill.name, skill);
        }
    }

    return [...dedupedSkills.values()].sort((a, b) => a.name.localeCompare(b.name));
}
