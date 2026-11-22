import { access, open, readdir, readFile, stat } from 'fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'path';
import { homedir } from 'os';
import { parse as parseYaml } from 'yaml';

export interface SkillSummary {
    name: string;
    description?: string;
}

export interface ResolvedSkill extends SkillSummary {
    body: string;
}

export const MAX_SKILL_FILE_BYTES = 128 * 1024;

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

type DiscoveredSkill = ResolvedSkill & {
    fileSize: number;
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
        case 'dsh':
            // DSH resolves its harness home from $DSH_HOME, then ~/.dsh.
            return process.env.DSH_HOME || join(getHomeDirectory(), '.dsh');
        case 'agy':
            return join(getHomeDirectory(), '.gemini', 'config');
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
        case 'copilot':
            roots.push(join(getAgentConfigDir(flavor), 'skills'));
            break;
        case 'dsh':
            // Mirrors DSH's own skill-filesystem provider: $DSH_HOME/skills.
            roots.push(join(getAgentConfigDir(flavor), 'skills'));
            break;
        case 'agy':
            roots.push(join(getAgentConfigDir(flavor), 'skills'));
            roots.push(join(home, '.gemini', 'antigravity-cli', 'skills'));
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
        case 'copilot':
            roots.push(join(directory, '.copilot', 'skills'));
            roots.push(join(directory, '.github', 'skills'));
            break;
        case 'dsh':
            // Mirrors DSH's own skill-filesystem provider: <project>/.dsh/skills.
            roots.push(join(directory, '.dsh', 'skills'));
            break;
        case 'agy':
            roots.push(join(directory, '.agent', 'skills'));
            roots.push(join(directory, '_agents', 'skills'));
            roots.push(join(directory, '_agent', 'skills'));
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

async function isDirectory(path: string): Promise<boolean> {
    return await stat(path).then((info) => info.isDirectory()).catch(() => false);
}

async function listAncestorProjectDirs(workingDirectory?: string): Promise<{ dirs: string[]; repoRoot?: string }> {
    if (!workingDirectory) {
        return { dirs: [] };
    }

    const resolvedWorkingDirectory = resolve(workingDirectory);
    const directories = [resolvedWorkingDirectory];
    let currentDirectory = resolvedWorkingDirectory;

    while (true) {
        if (await pathExists(join(currentDirectory, '.git'))) {
            return { dirs: directories, repoRoot: currentDirectory };
        }

        const parentDirectory = dirname(currentDirectory);
        if (parentDirectory === currentDirectory) {
            return { dirs: [resolvedWorkingDirectory] };
        }

        currentDirectory = parentDirectory;
        directories.push(currentDirectory);
    }
}

async function listProjectSkillsRoots(workingDirectory?: string, flavor?: string): Promise<string[]> {
    const { dirs } = await listAncestorProjectDirs(workingDirectory);
    return dirs.flatMap((directory) => getProjectSkillsRoots(directory, flavor));
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
        const entries = await readdir(skillsRoot);
        const result: string[] = [];

        for (const entry of entries) {
            const entryPath = join(skillsRoot, entry);
            if (!await isDirectory(entryPath)) {
                continue;
            }

            if (entry.startsWith('.')) {
                if (options.includeCodexSystem && entry === '.system') {
                    const systemEntries = await readdir(entryPath).catch(() => []);
                    for (const systemEntry of systemEntries) {
                        const systemEntryPath = join(entryPath, systemEntry);
                        if (!systemEntry.startsWith('.') && await isDirectory(systemEntryPath)) {
                            result.push(systemEntryPath);
                        }
                    }
                }
                continue;
            }

            result.push(entryPath);
        }

        return result;
    } catch {
        return [];
    }
}

async function readSkillFile(filePath: string): Promise<{ content: string; fileSize: number } | null> {
    try {
        const file = await open(filePath, 'r');
        try {
            const info = await file.stat();
            if (!info.isFile()) {
                return null;
            }

            const bytesToRead = Math.min(info.size, MAX_SKILL_FILE_BYTES + 1);
            const buffer = Buffer.alloc(bytesToRead);
            const { bytesRead } = await file.read(buffer, 0, bytesToRead, 0);
            return {
                content: buffer.subarray(0, bytesRead).toString('utf-8'),
                fileSize: info.size
            };
        } finally {
            await file.close();
        }
    } catch {
        return null;
    }
}

async function readSkillsFromDirs(skillDirs: string[]): Promise<DiscoveredSkill[]> {
    const skills = await Promise.all(skillDirs.map(async (dir): Promise<DiscoveredSkill | null> => {
        const filePath = join(dir, 'SKILL.md');
        const skillFile = await readSkillFile(filePath);
        if (!skillFile) {
            return null;
        }

        const summary = extractSkillSummary(dir, skillFile.content);
        if (!summary) {
            return null;
        }

        return {
            ...summary,
            body: parseFrontmatter(skillFile.content).body,
            fileSize: skillFile.fileSize
        };
    }));

    return skills.filter((skill): skill is DiscoveredSkill => skill !== null);
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

const AGY_PROJECT_DOT_DIRS = ['.agents', '.agent', '_agents', '_agent'] as const;
const AGY_PLUGIN_MANIFEST_REL_PATHS = [
    'plugin.json',
    join('.antigravity-plugin', 'plugin.json'),
    join('.gemini-plugin', 'plugin.json'),
    join('.claude-plugin', 'plugin.json'),
    'gemini-extension.json',
] as const;
const MAX_AGY_MANIFEST_DEPTH = 16;

type AgyNameFilter = {
    includeOnly?: string[];
    exclude?: string[];
};

type AgyManifestDirTarget = {
    dir: string;
    filters: AgyNameFilter[];
};

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
    try {
        const parsed = JSON.parse(await readFile(filePath, 'utf-8')) as unknown;
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
        return null;
    } catch {
        return null;
    }
}

function readStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const items = value
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim());
    return items.length > 0 ? items : undefined;
}

function parseAgyNameFilter(obj: Record<string, unknown>): AgyNameFilter | null {
    const includeOnly = readStringArray(obj.include_only);
    const exclude = readStringArray(obj.exclude);
    if (!includeOnly && !exclude) return null;
    return {
        ...(includeOnly ? { includeOnly } : {}),
        ...(exclude ? { exclude } : {}),
    };
}

function matchesAgyPattern(name: string, pattern: string): boolean {
    try {
        return new RegExp(`^(?:${pattern})$`).test(name);
    } catch {
        return name === pattern;
    }
}

function passesAgyFilters(name: string, filters: AgyNameFilter[]): boolean {
    for (const filter of filters) {
        if (filter.includeOnly && filter.includeOnly.length > 0) {
            if (!filter.includeOnly.some((pattern) => matchesAgyPattern(name, pattern))) {
                return false;
            }
        }
        if (filter.exclude && filter.exclude.length > 0) {
            if (filter.exclude.some((pattern) => matchesAgyPattern(name, pattern))) {
                return false;
            }
        }
    }
    return true;
}

async function readAgyPluginOverrides(configDir: string): Promise<Record<string, boolean>> {
    const config = await readJsonObject(join(configDir, 'config.json'));
    const rawPlugins = config?.plugins;
    if (rawPlugins === null || typeof rawPlugins !== 'object' || Array.isArray(rawPlugins)) {
        return {};
    }
    const overrides: Record<string, boolean> = {};
    for (const [name, entry] of Object.entries(rawPlugins)) {
        if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
            const enabled = (entry as { enabled?: unknown }).enabled;
            if (typeof enabled === 'boolean') {
                overrides[name] = enabled;
            }
        }
    }
    return overrides;
}

async function hasAgyPluginManifest(pluginDir: string): Promise<boolean> {
    const checks = await Promise.all(AGY_PLUGIN_MANIFEST_REL_PATHS.map((rel) => pathExists(join(pluginDir, rel))));
    return checks.some(Boolean);
}

async function isAgyPluginEnabled(
    pluginDir: string,
    dirName: string,
    overrides: Record<string, boolean>
): Promise<boolean> {
    if (Object.prototype.hasOwnProperty.call(overrides, dirName)) {
        return overrides[dirName]!;
    }
    const manifest = await readJsonObject(join(pluginDir, 'plugin.json'));
    if (manifest?.disabled === true) {
        return false;
    }
    return true;
}

async function resolveAgyManifestPath(
    rawPath: string,
    baseDir: string,
    repoRoot?: string
): Promise<string> {
    const trimmed = rawPath.trim();
    const home = getHomeDirectory();
    let expanded = trimmed;
    if (expanded === '~') {
        expanded = home;
    } else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
        expanded = join(home, expanded.slice(2));
    }
    if (isAbsolute(expanded)) {
        return resolve(expanded);
    }
    const againstBase = resolve(baseDir, expanded);
    if (!repoRoot || await pathExists(againstBase)) {
        return againstBase;
    }
    return resolve(repoRoot, expanded);
}

async function listAgyJsonManifestEntries(
    manifestPath: string,
    baseDir: string,
    repoRoot: string | undefined,
    inheritedFilters: AgyNameFilter[] = [],
    visited: Set<string> = new Set(),
    depth = 0
): Promise<AgyManifestDirTarget[]> {
    if (depth > MAX_AGY_MANIFEST_DEPTH) {
        return [];
    }
    const normalizedPath = resolve(manifestPath);
    if (visited.has(normalizedPath)) {
        return [];
    }
    visited.add(normalizedPath);

    const raw = await readJsonObject(normalizedPath);
    if (!raw) {
        return [];
    }

    const topExclude = readStringArray(raw.exclude);
    const baseFilters = topExclude
        ? [...inheritedFilters, { exclude: topExclude }]
        : inheritedFilters;

    const results: AgyManifestDirTarget[] = [];
    if (Array.isArray(raw.entries)) {
        for (const item of raw.entries) {
            if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
            const entry = item as Record<string, unknown>;
            if (typeof entry.path !== 'string' || entry.path.trim().length === 0) continue;
            const dir = await resolveAgyManifestPath(entry.path, baseDir, repoRoot);
            const entryFilter = parseAgyNameFilter(entry);
            results.push({
                dir,
                filters: entryFilter ? [...baseFilters, entryFilter] : baseFilters,
            });
        }
    }

    if (Array.isArray(raw.inherits)) {
        for (const item of raw.inherits) {
            if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
            const inh = item as Record<string, unknown>;
            if (typeof inh.path !== 'string' || inh.path.trim().length === 0) continue;
            const inheritedPath = await resolveAgyManifestPath(inh.path, baseDir, repoRoot);
            const inhFilter = parseAgyNameFilter(inh);
            const nextFilters = inhFilter ? [...baseFilters, inhFilter] : baseFilters;
            const nested = await listAgyJsonManifestEntries(
                inheritedPath,
                dirname(inheritedPath),
                repoRoot,
                nextFilters,
                visited,
                depth + 1
            );
            results.push(...nested);
        }
    }

    return results;
}

async function listAgyFilteredSkillDirs(skillsRoot: string, filters: AgyNameFilter[]): Promise<string[]> {
    const dirs = await listTopLevelSkillDirs(skillsRoot);
    return filters.length === 0
        ? dirs
        : dirs.filter((dir) => passesAgyFilters(basename(dir), filters));
}

async function listAgySkillDirsFromPluginsRoot(
    pluginsRoot: string,
    overrides: Record<string, boolean>,
    filters: AgyNameFilter[],
    requireManifest: boolean
): Promise<string[]> {
    const pluginDirs = await listTopLevelSkillDirs(pluginsRoot);
    const result: string[] = [];
    for (const pluginDir of pluginDirs) {
        const dirName = basename(pluginDir);
        if (!passesAgyFilters(dirName, filters)) {
            continue;
        }
        if (requireManifest && !await hasAgyPluginManifest(pluginDir)) {
            continue;
        }
        if (!await isAgyPluginEnabled(pluginDir, dirName, overrides)) {
            continue;
        }
        result.push(...await listTopLevelSkillDirs(join(pluginDir, 'skills')));
    }
    return result;
}

async function listAgyPluginDirsFromManifestTarget(
    target: AgyManifestDirTarget,
    overrides: Record<string, boolean>
): Promise<string[]> {
    const results = await listAgySkillDirsFromPluginsRoot(target.dir, overrides, target.filters, false);
    const dirName = basename(target.dir);
    if (
        passesAgyFilters(dirName, target.filters)
        && await hasAgyPluginManifest(target.dir)
        && await isAgyPluginEnabled(target.dir, dirName, overrides)
    ) {
        results.push(...await listTopLevelSkillDirs(join(target.dir, 'skills')));
    }
    return results;
}

async function discoverAgySkillDirs(workingDirectory?: string): Promise<string[]> {
    const home = getHomeDirectory();
    const configDir = getAgentConfigDir('agy');
    const [overrides, { dirs: projectDirs, repoRoot }] = await Promise.all([
        readAgyPluginOverrides(configDir),
        listAncestorProjectDirs(workingDirectory),
    ]);

    const orderedDirs: string[] = [];

    // 1. Project standard skills + project discovered plugins (closest ancestor first).
    for (const projectDir of projectDirs) {
        for (const root of getProjectSkillsRoots(projectDir, 'agy')) {
            orderedDirs.push(...await listTopLevelSkillDirs(root));
        }
        for (const dotDir of AGY_PROJECT_DOT_DIRS) {
            orderedDirs.push(
                ...await listAgySkillDirsFromPluginsRoot(
                    join(projectDir, dotDir, 'plugins'),
                    overrides,
                    [],
                    true
                )
            );
        }
    }

    // 2. Project declared skills.json and plugins.json manifests.
    for (const projectDir of projectDirs) {
        for (const dotDir of AGY_PROJECT_DOT_DIRS) {
            const dotRoot = join(projectDir, dotDir);
            const skillTargets = await listAgyJsonManifestEntries(join(dotRoot, 'skills.json'), dotRoot, repoRoot);
            for (const target of skillTargets) {
                orderedDirs.push(...await listAgyFilteredSkillDirs(target.dir, target.filters));
            }
            const pluginTargets = await listAgyJsonManifestEntries(join(dotRoot, 'plugins.json'), dotRoot, repoRoot);
            for (const target of pluginTargets) {
                orderedDirs.push(...await listAgyPluginDirsFromManifestTarget(target, overrides));
            }
        }
    }

    // 3. Global user standard skills + global discovered plugins.
    for (const userRoot of getUserSkillsRoots('agy')) {
        orderedDirs.push(...await listTopLevelSkillDirs(userRoot));
    }
    orderedDirs.push(
        ...await listAgySkillDirsFromPluginsRoot(join(configDir, 'plugins'), overrides, [], true),
        ...await listAgySkillDirsFromPluginsRoot(join(home, '.gemini', 'antigravity-cli', 'plugins'), overrides, [], true)
    );

    // 4. Global declared skills.json and plugins.json manifests.
    const globalSkillTargets = await listAgyJsonManifestEntries(join(configDir, 'skills.json'), configDir, undefined);
    for (const target of globalSkillTargets) {
        orderedDirs.push(...await listAgyFilteredSkillDirs(target.dir, target.filters));
    }
    const globalPluginTargets = await listAgyJsonManifestEntries(join(configDir, 'plugins.json'), configDir, undefined);
    for (const target of globalPluginTargets) {
        orderedDirs.push(...await listAgyPluginDirsFromManifestTarget(target, overrides));
    }

    return orderedDirs;
}

async function discoverSkills(workingDirectory?: string, options: { flavor?: string } = {}): Promise<DiscoveredSkill[]> {
    const flavor = normalizeFlavor(options.flavor);
    let candidateSkills: DiscoveredSkill[];
    if (flavor === 'agy') {
        const orderedDirs = await discoverAgySkillDirs(workingDirectory);
        candidateSkills = await readSkillsFromDirs(orderedDirs);
    } else {
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
        candidateSkills = [
            ...projectSkills,
            ...userSkills,
            ...pluginSkills,
            ...adminSkills,
        ];
    }

    const dedupedSkills = new Map<string, DiscoveredSkill>();
    for (const skill of candidateSkills) {
        if (!dedupedSkills.has(skill.name)) {
            dedupedSkills.set(skill.name, skill);
        }
    }

    return [...dedupedSkills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function listSkills(workingDirectory?: string, options: { flavor?: string } = {}): Promise<SkillSummary[]> {
    const skills = await discoverSkills(workingDirectory, options);
    return skills.map(({ name, description }) => ({ name, description }));
}

function validateSkillName(name: string): string {
    const trimmed = name.trim();
    if (
        !trimmed
        || trimmed.length > 128
        || trimmed === '.'
        || trimmed === '..'
        || trimmed.includes('/')
        || trimmed.includes('\\')
        || trimmed.includes('\0')
    ) {
        throw new Error('Invalid skill name');
    }
    return trimmed;
}

export async function resolveSkill(
    name: string,
    workingDirectory?: string,
    options: { flavor?: string } = {}
): Promise<ResolvedSkill | null> {
    const skillName = validateSkillName(name);
    const skills = await discoverSkills(workingDirectory, options);
    const skill = skills.find((candidate) => candidate.name === skillName);
    if (!skill) {
        return null;
    }
    if (skill.fileSize > MAX_SKILL_FILE_BYTES) {
        throw new Error(`Skill is too large to load (maximum ${MAX_SKILL_FILE_BYTES} bytes)`);
    }
    return {
        name: skill.name,
        description: skill.description,
        body: skill.body
    };
}
