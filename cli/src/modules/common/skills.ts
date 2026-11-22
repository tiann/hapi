import { constants } from 'fs';
import { access, open, readdir, readFile, realpath, stat } from 'fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
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
const MAX_AGY_MANIFEST_BYTES = 256 * 1024;

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

async function readSkillsFromDirs(skillDirs: ReadonlyArray<string | AgySkillDirCandidate>): Promise<DiscoveredSkill[]> {
    const skills = await Promise.all(skillDirs.map(async (entry): Promise<DiscoveredSkill | null> => {
        const dir = typeof entry === 'string' ? entry : entry.dir;
        const canonicalBoundary = typeof entry === 'string' ? undefined : entry.canonicalBoundary;
        const rawFilePath = join(dir, 'SKILL.md');
        let filePath = rawFilePath;
        if (canonicalBoundary) {
            const canonicalFile = await safeRealpath(rawFilePath);
            if (!canonicalFile || !isPathWithinRoot(canonicalFile, canonicalBoundary)) {
                return null;
            }
            filePath = canonicalFile;
        }
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
    canonicalBoundary?: string;
};

type AgySkillDirCandidate = {
    dir: string;
    canonicalBoundary?: string;
};

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
    let handle;
    try {
        handle = await open(filePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
        const stats = await handle.stat();
        if (!stats.isFile() || stats.size > MAX_AGY_MANIFEST_BYTES) {
            return null;
        }
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        const buf = Buffer.allocUnsafe(Math.min(Math.max(stats.size, 1), 65536));
        while (totalBytes <= MAX_AGY_MANIFEST_BYTES) {
            const { bytesRead } = await handle.read(buf, 0, buf.length, totalBytes);
            if (bytesRead === 0) break;
            totalBytes += bytesRead;
            if (totalBytes > MAX_AGY_MANIFEST_BYTES) {
                return null;
            }
            chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
        }
        const parsed = JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf-8')) as unknown;
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
        return null;
    } catch {
        return null;
    } finally {
        await handle?.close().catch(() => {});
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

type AgyNfaState =
    | { kind: 'split'; out1: number; out2: number }
    | { kind: 'anchor'; at: 'start' | 'end'; out: number }
    | { kind: 'char'; test: (ch: string) => boolean; out: number }
    | { kind: 'match' };

type AgyNfaFragment = {
    start: number;
    patch: Array<(target: number) => void>;
};

function compileAgyPatternNfa(pattern: string): { states: AgyNfaState[]; start: number; matchId: number } | null {
    if (pattern.length > 512) return null;
    const states: AgyNfaState[] = [];
    let pos = 0;

    const pushState = (state: AgyNfaState): number => {
        if (states.length >= 1024) throw new Error('pattern too large');
        states.push(state);
        return states.length - 1;
    };

    const escapePredicate = (ch: string): ((c: string) => boolean) => {
        switch (ch) {
            case 'd': return (c) => c >= '0' && c <= '9';
            case 'D': return (c) => !(c >= '0' && c <= '9');
            case 'w': return (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_';
            case 'W': return (c) => !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_');
            case 's': return (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
            case 'S': return (c) => !(c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v');
            default: return (c) => c === ch;
        }
    };

    const parseCharClass = (): ((c: string) => boolean) => {
        let negated = false;
        if (pattern[pos] === '^') {
            negated = true;
            pos += 1;
        }
        const tests: Array<(c: string) => boolean> = [];
        let first = true;
        while (pos < pattern.length && (first || pattern[pos] !== ']')) {
            first = false;
            if (pattern[pos] === '\\') {
                pos += 1;
                if (pos >= pattern.length) throw new Error('unterminated escape');
                const esc = pattern[pos]!;
                pos += 1;
                tests.push(escapePredicate(esc));
                continue;
            }
            const startCh = pattern[pos]!;
            pos += 1;
            if (pattern[pos] === '-' && pos + 1 < pattern.length && pattern[pos + 1] !== ']') {
                pos += 1;
                let endCh = pattern[pos]!;
                if (endCh === '\\') {
                    pos += 1;
                    if (pos >= pattern.length) throw new Error('unterminated escape');
                    endCh = pattern[pos]!;
                }
                pos += 1;
                if (startCh > endCh) throw new Error('invalid range');
                tests.push((c) => c >= startCh && c <= endCh);
            } else {
                tests.push((c) => c === startCh);
            }
        }
        if (pattern[pos] !== ']') throw new Error('unterminated class');
        pos += 1;
        return (c) => {
            const matched = tests.some((fn) => fn(c));
            return negated ? !matched : matched;
        };
    };

    const makeEpsilon = (): AgyNfaFragment => {
        const st: AgyNfaState = { kind: 'split', out1: -1, out2: -1 };
        const id = pushState(st);
        return { start: id, patch: [(t) => { st.out1 = t; }] };
    };

    const makeChar = (test: (c: string) => boolean): AgyNfaFragment => {
        const st: AgyNfaState = { kind: 'char', test, out: -1 };
        const id = pushState(st);
        return { start: id, patch: [(t) => { st.out = t; }] };
    };

    const parseAlt = (): AgyNfaFragment => {
        let left = parseConcat();
        while (pos < pattern.length && pattern[pos] === '|') {
            pos += 1;
            const right = parseConcat();
            const st: AgyNfaState = { kind: 'split', out1: left.start, out2: right.start };
            const id = pushState(st);
            left = { start: id, patch: [...left.patch, ...right.patch] };
        }
        return left;
    };

    const parseConcat = (): AgyNfaFragment => {
        let current: AgyNfaFragment | null = null;
        while (pos < pattern.length && pattern[pos] !== '|' && pattern[pos] !== ')') {
            const next = parsePostfix();
            if (!current) {
                current = next;
            } else {
                for (const fn of current.patch) fn(next.start);
                current = { start: current.start, patch: next.patch };
            }
        }
        return current ?? makeEpsilon();
    };

    const parsePostfix = (): AgyNfaFragment => {
        let frag = parseAtom();
        while (pos < pattern.length) {
            const op = pattern[pos];
            if (op !== '*' && op !== '+' && op !== '?') break;
            pos += 1;
            if (pattern[pos] === '?') pos += 1;
            if (op === '*') {
                const st: AgyNfaState = { kind: 'split', out1: frag.start, out2: -1 };
                const id = pushState(st);
                for (const fn of frag.patch) fn(id);
                frag = { start: id, patch: [(t) => { st.out2 = t; }] };
            } else if (op === '+') {
                const st: AgyNfaState = { kind: 'split', out1: frag.start, out2: -1 };
                const id = pushState(st);
                for (const fn of frag.patch) fn(id);
                frag = { start: frag.start, patch: [(t) => { st.out2 = t; }] };
            } else {
                const st: AgyNfaState = { kind: 'split', out1: frag.start, out2: -1 };
                const id = pushState(st);
                frag = { start: id, patch: [...frag.patch, (t) => { st.out2 = t; }] };
            }
        }
        return frag;
    };

    const parseAtom = (): AgyNfaFragment => {
        const ch = pattern[pos];
        if (ch === undefined || ch === '*' || ch === '+' || ch === '?' || ch === '{' || ch === '}') {
            throw new Error('unexpected quantifier');
        }
        if (ch === '^' || ch === '$') {
            pos += 1;
            const st: AgyNfaState = { kind: 'anchor', at: ch === '^' ? 'start' : 'end', out: -1 };
            const id = pushState(st);
            return { start: id, patch: [(t) => { st.out = t; }] };
        }
        if (ch === '(') {
            pos += 1;
            if (pattern[pos] === '?') {
                if (pattern[pos + 1] !== ':') throw new Error('unsupported group');
                pos += 2;
            }
            const inner = parseAlt();
            if (pattern[pos] !== ')') throw new Error('unclosed group');
            pos += 1;
            return inner;
        }
        if (ch === '[') {
            pos += 1;
            return makeChar(parseCharClass());
        }
        if (ch === '.') {
            pos += 1;
            return makeChar((c) => c !== '\n' && c !== '\r');
        }
        if (ch === '\\') {
            pos += 1;
            if (pos >= pattern.length) throw new Error('unterminated escape');
            const esc = pattern[pos]!;
            if (esc >= '1' && esc <= '9') throw new Error('backreference unsupported');
            pos += 1;
            return makeChar(escapePredicate(esc));
        }
        pos += 1;
        return makeChar((c) => c === ch);
    };

    try {
        const root = parseAlt();
        if (pos !== pattern.length) return null;
        const matchId = pushState({ kind: 'match' });
        for (const fn of root.patch) fn(matchId);
        return { states, start: root.start, matchId };
    } catch {
        return null;
    }
}

function matchesAgyPattern(name: string, pattern: string): boolean {
    const nfa = compileAgyPatternNfa(pattern);
    if (!nfa) return name === pattern;

    const addState = (set: Set<number>, id: number, atStart: boolean, atEnd: boolean) => {
        if (id < 0 || set.has(id)) return;
        set.add(id);
        const st = nfa.states[id]!;
        if (st.kind === 'split') {
            addState(set, st.out1, atStart, atEnd);
            addState(set, st.out2, atStart, atEnd);
        } else if (st.kind === 'anchor') {
            if ((st.at === 'start' && atStart) || (st.at === 'end' && atEnd)) {
                addState(set, st.out, atStart, atEnd);
            }
        }
    };

    let current = new Set<number>();
    addState(current, nfa.start, true, name.length === 0);
    for (let i = 0; i < name.length; i += 1) {
        const ch = name[i]!;
        const next = new Set<number>();
        const atEnd = i + 1 === name.length;
        for (const id of current) {
            const st = nfa.states[id]!;
            if (st.kind === 'char' && st.test(ch)) {
                addState(next, st.out, false, atEnd);
            }
        }
        current = next;
        if (current.size === 0) return false;
    }
    return current.has(nfa.matchId);
}

function matchesAgyNameOrRelPath(name: string, pattern: string, relPath?: string): boolean {
    if (matchesAgyPattern(name, pattern)) return true;
    if (relPath !== undefined && relPath !== name) {
        const normalizedPattern = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
        return matchesAgyPattern(relPath, normalizedPattern);
    }
    return false;
}

function passesAgyFilters(name: string, filters: AgyNameFilter[], relPath?: string): boolean {
    for (const filter of filters) {
        if (filter.includeOnly && filter.includeOnly.length > 0) {
            if (!filter.includeOnly.some((pattern) => matchesAgyNameOrRelPath(name, pattern, relPath))) {
                return false;
            }
        }
        if (filter.exclude && filter.exclude.length > 0) {
            if (filter.exclude.some((pattern) => matchesAgyNameOrRelPath(name, pattern, relPath))) {
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

async function safeRealpath(targetPath: string): Promise<string | null> {
    try {
        return await realpath(targetPath);
    } catch {
        return null;
    }
}

function isPathWithinRoot(targetPath: string, rootDir: string): boolean {
    const normalizedTarget = resolve(targetPath);
    const normalizedRoot = resolve(rootDir);
    const rel = process.platform === 'win32'
        ? relative(normalizedRoot.toLowerCase(), normalizedTarget.toLowerCase())
        : relative(normalizedRoot, normalizedTarget);
    return rel === '' || (!/^\.\.(?:[\\/]|$)/.test(rel) && !isAbsolute(rel));
}

async function isCanonicalPathWithinRoot(targetPath: string, canonicalBoundary: string): Promise<boolean> {
    const canonicalTarget = await safeRealpath(targetPath);
    return canonicalTarget !== null && isPathWithinRoot(canonicalTarget, canonicalBoundary);
}

async function hasAgyPluginManifest(pluginDir: string, canonicalBoundary?: string): Promise<boolean> {
    for (const rel of AGY_PLUGIN_MANIFEST_REL_PATHS) {
        const manifestPath = join(pluginDir, rel);
        if (!await pathExists(manifestPath)) continue;
        if (!canonicalBoundary || await isCanonicalPathWithinRoot(manifestPath, canonicalBoundary)) {
            return true;
        }
    }
    return false;
}

async function isAgyPluginEnabled(
    pluginDir: string,
    dirName: string,
    overrides: Record<string, boolean>,
    canonicalBoundary?: string
): Promise<boolean> {
    if (Object.prototype.hasOwnProperty.call(overrides, dirName)) {
        return overrides[dirName]!;
    }
    const pluginJsonPath = join(pluginDir, 'plugin.json');
    if (canonicalBoundary && await pathExists(pluginJsonPath) && !await isCanonicalPathWithinRoot(pluginJsonPath, canonicalBoundary)) {
        return false;
    }
    const manifest = await readJsonObject(pluginJsonPath);
    if (manifest?.disabled === true) {
        return false;
    }
    return true;
}

async function resolveAgyManifestPath(
    rawPath: string,
    primaryRoot: string,
    fallbackRoot?: string
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
    const againstPrimary = resolve(primaryRoot, expanded);
    if (!fallbackRoot || fallbackRoot === primaryRoot || await pathExists(againstPrimary)) {
        return againstPrimary;
    }
    return resolve(fallbackRoot, expanded);
}

const MAX_AGY_MANIFEST_EXPANSIONS = 64;

type AgyManifestTraversalState = {
    expansions: number;
    jsonCache: Map<string, Record<string, unknown> | null>;
    expansionCache: Map<string, AgyManifestDirTarget[]>;
};

function createAgyManifestTraversalState(): AgyManifestTraversalState {
    return {
        expansions: 0,
        jsonCache: new Map(),
        expansionCache: new Map(),
    };
}

async function readCachedAgyJsonObject(
    filePath: string,
    state?: AgyManifestTraversalState
): Promise<Record<string, unknown> | null> {
    const key = resolve(filePath);
    if (state?.jsonCache.has(key)) {
        return state.jsonCache.get(key) ?? null;
    }
    const parsed = await readJsonObject(key);
    state?.jsonCache.set(key, parsed);
    return parsed;
}

async function listAgyJsonManifestEntries(
    manifestPath: string,
    primaryRoot: string,
    fallbackRoot: string | undefined,
    inheritedFilters: AgyNameFilter[] = [],
    ancestors: ReadonlySet<string> = new Set(),
    depth = 0,
    workspaceRoot?: string,
    canonicalBoundary?: string,
    state: AgyManifestTraversalState = createAgyManifestTraversalState()
): Promise<AgyManifestDirTarget[]> {
    if (depth > MAX_AGY_MANIFEST_DEPTH || state.expansions >= MAX_AGY_MANIFEST_EXPANSIONS) {
        return [];
    }
    const normalizedPath = resolve(manifestPath);
    const canonicalManifest = await safeRealpath(normalizedPath);
    if (canonicalBoundary && (!canonicalManifest || !isPathWithinRoot(canonicalManifest, canonicalBoundary))) {
        return [];
    }
    const visitKey = canonicalManifest ?? normalizedPath;
    if (ancestors.has(visitKey)) {
        return [];
    }
    const cacheKey = JSON.stringify([
        visitKey,
        resolve(primaryRoot),
        fallbackRoot ? resolve(fallbackRoot) : '',
        workspaceRoot ? resolve(workspaceRoot) : '',
        canonicalBoundary ?? '',
        inheritedFilters,
    ]);
    const cachedExpansion = state.expansionCache.get(cacheKey);
    if (cachedExpansion) {
        return cachedExpansion;
    }
    state.expansions += 1;

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(visitKey);

    const raw = await readCachedAgyJsonObject(visitKey, state);
    if (!raw) {
        state.expansionCache.set(cacheKey, []);
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
            const dir = await resolveAgyManifestPath(entry.path, primaryRoot, fallbackRoot);
            if (canonicalBoundary && !await isCanonicalPathWithinRoot(dir, canonicalBoundary)) {
                continue;
            }
            const entryFilter = parseAgyNameFilter(entry);
            results.push({
                dir,
                filters: entryFilter ? [...baseFilters, entryFilter] : baseFilters,
                ...(canonicalBoundary ? { canonicalBoundary } : {}),
            });
        }
    }

    if (Array.isArray(raw.inherits)) {
        for (const item of raw.inherits) {
            if (state.expansions >= MAX_AGY_MANIFEST_EXPANSIONS) break;
            if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
            const inh = item as Record<string, unknown>;
            if (typeof inh.path !== 'string' || inh.path.trim().length === 0) continue;
            const inheritedPath = await resolveAgyManifestPath(inh.path, primaryRoot, fallbackRoot);
            if (canonicalBoundary && !await isCanonicalPathWithinRoot(inheritedPath, canonicalBoundary)) {
                continue;
            }
            const inhFilter = parseAgyNameFilter(inh);
            const nextFilters = inhFilter ? [...baseFilters, inhFilter] : baseFilters;
            const staysInWorkspace = workspaceRoot !== undefined && isPathWithinRoot(inheritedPath, workspaceRoot);
            const nested = await listAgyJsonManifestEntries(
                inheritedPath,
                staysInWorkspace ? workspaceRoot : dirname(inheritedPath),
                staysInWorkspace ? fallbackRoot : undefined,
                nextFilters,
                nextAncestors,
                depth + 1,
                staysInWorkspace ? workspaceRoot : undefined,
                canonicalBoundary,
                state
            );
            results.push(...nested);
        }
    }

    const dedupedResults: AgyManifestDirTarget[] = [];
    const seenTargets = new Set<string>();
    for (const target of results) {
        const targetKey = JSON.stringify([
            resolve(target.dir),
            target.canonicalBoundary ?? '',
            target.filters,
        ]);
        if (seenTargets.has(targetKey)) continue;
        seenTargets.add(targetKey);
        dedupedResults.push(target);
    }

    state.expansionCache.set(cacheKey, dedupedResults);
    return dedupedResults;
}

async function filterAgyCanonicalDirs(dirs: string[], canonicalBoundary?: string): Promise<string[]> {
    if (!canonicalBoundary) return dirs;
    const checks = await Promise.all(dirs.map(async (dir) => await isCanonicalPathWithinRoot(dir, canonicalBoundary) ? dir : null));
    return checks.filter((dir): dir is string => dir !== null);
}

async function appendExplicitAgyNestedDirs(
    rootDir: string,
    dirs: string[],
    filters: AgyNameFilter[],
    canonicalBoundary?: string,
    requiredChildFile?: string
): Promise<void> {
    const seen = new Set(dirs.map((dir) => resolve(dir)));
    for (const filter of filters) {
        for (const pattern of filter.includeOnly ?? []) {
            if (!pattern.includes('/') && !pattern.includes('\\')) continue;
            const relSelector = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
            if (!relSelector || isAbsolute(relSelector)) continue;
            const candidateDir = resolve(rootDir, relSelector);
            if (!isPathWithinRoot(candidateDir, rootDir) || seen.has(candidateDir)) continue;
            const checkPath = requiredChildFile ? join(candidateDir, requiredChildFile) : candidateDir;
            if (!await pathExists(checkPath)) continue;
            if (canonicalBoundary && !await isCanonicalPathWithinRoot(candidateDir, canonicalBoundary)) continue;
            seen.add(candidateDir);
            dirs.push(candidateDir);
        }
    }
}

async function listAgyFilteredSkillDirs(
    skillsRoot: string,
    filters: AgyNameFilter[],
    canonicalBoundary?: string
): Promise<string[]> {
    const dirs = await filterAgyCanonicalDirs(await listTopLevelSkillDirs(skillsRoot), canonicalBoundary);
    await appendExplicitAgyNestedDirs(skillsRoot, dirs, filters, canonicalBoundary, 'SKILL.md');
    return filters.length === 0
        ? dirs
        : dirs.filter((dir) => {
              const rel = relative(skillsRoot, dir).replace(/\\/g, '/');
              return passesAgyFilters(basename(dir), filters, rel);
          });
}

async function readAgyPluginManifest(
    pluginDir: string,
    canonicalBoundary?: string,
    state?: AgyManifestTraversalState
): Promise<Record<string, unknown> | null> {
    for (const rel of AGY_PLUGIN_MANIFEST_REL_PATHS) {
        const manifestPath = join(pluginDir, rel);
        if (!await pathExists(manifestPath)) continue;
        if (canonicalBoundary && !await isCanonicalPathWithinRoot(manifestPath, canonicalBoundary)) {
            continue;
        }
        const parsed = await readCachedAgyJsonObject(manifestPath, state);
        if (parsed) return parsed;
    }
    return null;
}

async function listAgySkillDirsFromPluginDir(
    pluginDir: string,
    canonicalBoundary?: string,
    state?: AgyManifestTraversalState
): Promise<string[]> {
    const pluginBoundary = canonicalBoundary ?? await safeRealpath(pluginDir) ?? undefined;
    const manifest = await readAgyPluginManifest(pluginDir, pluginBoundary, state);
    const pluginFilters: AgyNameFilter[] = [];
    const collected: string[] = [];

    const localSkillManifests = [
        join(pluginDir, 'skills.json'),
        ...AGY_PROJECT_DOT_DIRS.map((dot) => join(pluginDir, dot, 'skills.json')),
    ];
    for (const skillsManifestPath of localSkillManifests) {
        if (!await pathExists(skillsManifestPath)) continue;
        if (pluginBoundary && !await isCanonicalPathWithinRoot(skillsManifestPath, pluginBoundary)) continue;
        const raw = await readCachedAgyJsonObject(skillsManifestPath, state);
        if (!raw) continue;
        const localFilter = parseAgyNameFilter(raw);
        if (localFilter) {
            pluginFilters.push(localFilter);
        }
        const targets = await listAgyJsonManifestEntries(
            skillsManifestPath,
            pluginDir,
            pluginDir,
            [],
            new Set(),
            0,
            pluginDir,
            pluginBoundary,
            state
        );
        for (const target of targets) {
            collected.push(...await listAgyFilteredSkillDirs(target.dir, target.filters, pluginBoundary));
        }
    }

    let declaredSkillPaths: string[] = [];
    if (typeof manifest?.skills === 'string' && manifest.skills.trim().length > 0) {
        declaredSkillPaths = [manifest.skills.trim()];
    } else if (Array.isArray(manifest?.skills)) {
        declaredSkillPaths = readStringArray(manifest.skills) ?? [];
    } else if (manifest?.skills !== null && typeof manifest?.skills === 'object') {
        const skillsObj = manifest.skills as Record<string, unknown>;
        const objFilter = parseAgyNameFilter(skillsObj);
        if (objFilter) pluginFilters.push(objFilter);
        declaredSkillPaths = readStringArray(skillsObj.paths) ?? [];
    }

    for (const relPath of declaredSkillPaths) {
        if (isAbsolute(relPath)) continue;
        const resolvedTarget = resolve(pluginDir, relPath);
        if (!isPathWithinRoot(resolvedTarget, pluginDir)) continue;
        if (pluginBoundary && !await isCanonicalPathWithinRoot(resolvedTarget, pluginBoundary)) continue;
        const directSkillFile = join(resolvedTarget, 'SKILL.md');
        if (await pathExists(directSkillFile)) {
            if (!pluginBoundary || await isCanonicalPathWithinRoot(directSkillFile, pluginBoundary)) {
                collected.push(resolvedTarget);
            }
        } else {
            collected.push(...await listAgyFilteredSkillDirs(resolvedTarget, pluginFilters, pluginBoundary));
        }
    }

    collected.push(...await listAgyFilteredSkillDirs(join(pluginDir, 'skills'), pluginFilters, pluginBoundary));

    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const dir of collected) {
        const key = resolve(dir);
        if (seen.has(key)) continue;
        const rel = relative(pluginDir, dir).replace(/\\/g, '/');
        if (pluginFilters.length > 0 && !passesAgyFilters(basename(dir), pluginFilters, rel)) {
            continue;
        }
        seen.add(key);
        deduped.push(dir);
    }
    return deduped;
}

async function listAgySkillDirsFromPluginsRoot(
    pluginsRoot: string,
    overrides: Record<string, boolean>,
    filters: AgyNameFilter[],
    requireManifest: boolean,
    canonicalBoundary?: string,
    state?: AgyManifestTraversalState
): Promise<string[]> {
    const pluginDirs = await filterAgyCanonicalDirs(await listTopLevelSkillDirs(pluginsRoot), canonicalBoundary);
    await appendExplicitAgyNestedDirs(pluginsRoot, pluginDirs, filters, canonicalBoundary);
    const result: string[] = [];
    for (const pluginDir of pluginDirs) {
        const dirName = basename(pluginDir);
        const rel = relative(pluginsRoot, pluginDir).replace(/\\/g, '/');
        if (!passesAgyFilters(dirName, filters, rel)) {
            continue;
        }
        if (requireManifest && !await hasAgyPluginManifest(pluginDir, canonicalBoundary)) {
            continue;
        }
        if (rel !== dirName && Object.prototype.hasOwnProperty.call(overrides, rel)) {
            if (!overrides[rel]) continue;
        } else if (!await isAgyPluginEnabled(pluginDir, dirName, overrides, canonicalBoundary)) {
            continue;
        }
        result.push(...await listAgySkillDirsFromPluginDir(pluginDir, canonicalBoundary, state));
    }
    return result;
}

async function listAgyPluginDirsFromManifestTarget(
    target: AgyManifestDirTarget,
    overrides: Record<string, boolean>,
    state?: AgyManifestTraversalState
): Promise<string[]> {
    const results = await listAgySkillDirsFromPluginsRoot(
        target.dir,
        overrides,
        target.filters,
        false,
        target.canonicalBoundary,
        state
    );
    const dirName = basename(target.dir);
    if (
        (!target.canonicalBoundary || await isCanonicalPathWithinRoot(target.dir, target.canonicalBoundary))
        && passesAgyFilters(dirName, target.filters)
        && await hasAgyPluginManifest(target.dir, target.canonicalBoundary)
        && await isAgyPluginEnabled(target.dir, dirName, overrides, target.canonicalBoundary)
    ) {
        results.push(...await listAgySkillDirsFromPluginDir(target.dir, target.canonicalBoundary, state));
    }
    return results;
}

async function discoverAgySkillDirs(workingDirectory?: string): Promise<AgySkillDirCandidate[]> {
    const home = getHomeDirectory();
    const configDir = getAgentConfigDir('agy');
    const [overrides, { dirs: projectDirs, repoRoot }] = await Promise.all([
        readAgyPluginOverrides(configDir),
        listAncestorProjectDirs(workingDirectory),
    ]);

    const manifestState = createAgyManifestTraversalState();
    const canonicalRepoBoundary = repoRoot ? await safeRealpath(repoRoot) : null;
    const orderedDirs: AgySkillDirCandidate[] = [];
    const pushDirs = (dirs: string[], canonicalBoundary?: string) => {
        for (const dir of dirs) {
            orderedDirs.push(canonicalBoundary ? { dir, canonicalBoundary } : { dir });
        }
    };

    // 1. Project standard skills + project discovered plugins (closest ancestor first).
    for (const projectDir of projectDirs) {
        const projectBoundary = canonicalRepoBoundary ?? await safeRealpath(projectDir);
        if (!projectBoundary) continue;
        for (const root of getProjectSkillsRoots(projectDir, 'agy')) {
            pushDirs(
                await filterAgyCanonicalDirs(await listTopLevelSkillDirs(root), projectBoundary),
                projectBoundary
            );
        }
        for (const dotDir of AGY_PROJECT_DOT_DIRS) {
            pushDirs(
                await listAgySkillDirsFromPluginsRoot(
                    join(projectDir, dotDir, 'plugins'),
                    overrides,
                    [],
                    true,
                    projectBoundary,
                    manifestState
                ),
                projectBoundary
            );
        }
    }

    // 2. Project declared skills.json and plugins.json manifests.
    for (const projectDir of projectDirs) {
        const projectBoundary = canonicalRepoBoundary ?? await safeRealpath(projectDir);
        if (!projectBoundary) continue;
        for (const dotDir of AGY_PROJECT_DOT_DIRS) {
            const dotRoot = join(projectDir, dotDir);
            const skillTargets = await listAgyJsonManifestEntries(
                join(dotRoot, 'skills.json'),
                projectDir,
                repoRoot,
                [],
                new Set(),
                0,
                projectDir,
                projectBoundary,
                manifestState
            );
            for (const target of skillTargets) {
                pushDirs(
                    await listAgyFilteredSkillDirs(target.dir, target.filters, target.canonicalBoundary),
                    projectBoundary
                );
            }
            const pluginTargets = await listAgyJsonManifestEntries(
                join(dotRoot, 'plugins.json'),
                projectDir,
                repoRoot,
                [],
                new Set(),
                0,
                projectDir,
                projectBoundary,
                manifestState
            );
            for (const target of pluginTargets) {
                pushDirs(
                    await listAgyPluginDirsFromManifestTarget(target, overrides, manifestState),
                    projectBoundary
                );
            }
        }
    }

    // 3. Global user standard skills + global discovered plugins.
    for (const userRoot of getUserSkillsRoots('agy')) {
        pushDirs(await listTopLevelSkillDirs(userRoot));
    }
    pushDirs(await listAgySkillDirsFromPluginsRoot(join(configDir, 'plugins'), overrides, [], true, undefined, manifestState));
    pushDirs(await listAgySkillDirsFromPluginsRoot(join(home, '.gemini', 'antigravity-cli', 'plugins'), overrides, [], true, undefined, manifestState));

    // 4. Global declared skills.json and plugins.json manifests.
    const globalSkillTargets = await listAgyJsonManifestEntries(join(configDir, 'skills.json'), configDir, undefined, [], new Set(), 0, undefined, undefined, manifestState);
    for (const target of globalSkillTargets) {
        pushDirs(await listAgyFilteredSkillDirs(target.dir, target.filters));
    }
    const globalPluginTargets = await listAgyJsonManifestEntries(join(configDir, 'plugins.json'), configDir, undefined, [], new Set(), 0, undefined, undefined, manifestState);
    for (const target of globalPluginTargets) {
        pushDirs(await listAgyPluginDirsFromManifestTarget(target, overrides, manifestState));
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
