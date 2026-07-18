import { access, readdir, readFile } from 'fs/promises';
import { basename, dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { parse as parseYaml } from 'yaml';
import { listEnabledCodexPluginInstallations, resolveRealFileInside } from './codexPlugins';

export interface SkillSummary {
    name: string;
    description?: string;
}

export interface ListSkillsRequest {
    agent?: string;
}

export interface ListSkillsResponse {
    success: boolean;
    skills?: SkillSummary[];
    error?: string;
}

function getHomeDirectory(): string {
    return process.env.HOME ?? process.env.USERPROFILE ?? homedir();
}

function getUserSkillsRoots(): string[] {
    const home = getHomeDirectory();
    return [
        join(home, '.agents', 'skills'),
        join(home, '.claude', 'skills'),
        join(home, '.codex', 'skills'),
    ];
}

function getAdminSkillsRoot(): string {
    return join('/etc', 'codex', 'skills');
}

function getProjectSkillsRoots(directory: string): string[] {
    return [
        join(directory, '.agents', 'skills'),
        join(directory, '.claude', 'skills'),
    ];
}

interface SkillDirEntry {
    dir: string;
    namePrefix?: string;
    skillFilePath?: string;
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

async function listProjectSkillsRoots(workingDirectory?: string): Promise<string[]> {
    if (!workingDirectory) {
        return [];
    }

    const resolvedWorkingDirectory = resolve(workingDirectory);
    const directories = [resolvedWorkingDirectory];
    let currentDirectory = resolvedWorkingDirectory;

    while (true) {
        if (await pathExists(join(currentDirectory, '.git'))) {
            return directories.flatMap(getProjectSkillsRoots);
        }

        const parentDirectory = dirname(currentDirectory);
        if (parentDirectory === currentDirectory) {
            return getProjectSkillsRoots(resolvedWorkingDirectory);
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

function extractSkillSummary(skillDir: string, fileContent: string, namePrefix?: string): SkillSummary | null {
    const parsed = parseFrontmatter(fileContent);
    const nameFromFrontmatter = typeof parsed.frontmatter?.name === 'string' ? parsed.frontmatter.name.trim() : '';
    const baseName = nameFromFrontmatter || basename(skillDir);
    if (!baseName) {
        return null;
    }
    const name = namePrefix ? `${namePrefix}:${baseName}` : baseName;

    const description = typeof parsed.frontmatter?.description === 'string'
        ? parsed.frontmatter.description.trim()
        : undefined;

    return { name, description };
}

async function listTopLevelSkillDirs(skillsRoot: string): Promise<string[]> {
    try {
        const entries = await readdir(skillsRoot, { withFileTypes: true });
        const result: string[] = [];

        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith('.')) {
                continue;
            }

            result.push(join(skillsRoot, entry.name));
        }

        return result;
    } catch {
        return [];
    }
}

async function listCodexPluginSkillDirs(): Promise<SkillDirEntry[]> {
    const installations = await listEnabledCodexPluginInstallations();
    const skillDirs = await Promise.all(installations.map(async (installation) => {
        const dirs = await listTopLevelSkillDirs(join(installation.installPath, 'skills'));
        const entries = await Promise.all(dirs.map(async (dir): Promise<SkillDirEntry | null> => {
            const skillName = basename(dir);
            const skillFilePath = await resolveRealFileInside(installation.installPath, 'skills', skillName, 'SKILL.md');
            if (!skillFilePath) {
                return null;
            }

            return {
                dir,
                namePrefix: installation.pluginName,
                skillFilePath,
            };
        }));
        return entries.filter((entry): entry is SkillDirEntry => entry !== null);
    }));

    return skillDirs.flat();
}

async function readSkillsFromDirs(skillDirs: Array<string | SkillDirEntry>): Promise<SkillSummary[]> {
    const skills = await Promise.all(skillDirs.map(async (entry): Promise<SkillSummary | null> => {
        const dir = typeof entry === 'string' ? entry : entry.dir;
        const namePrefix = typeof entry === 'string' ? undefined : entry.namePrefix;
        const filePath = typeof entry === 'string' ? join(dir, 'SKILL.md') : entry.skillFilePath ?? join(dir, 'SKILL.md');
        try {
            const fileContent = await readFile(filePath, 'utf-8');
            return extractSkillSummary(dir, fileContent, namePrefix);
        } catch {
            return null;
        }
    }));

    return skills.filter((skill): skill is SkillSummary => skill !== null);
}

export async function listSkills(workingDirectory?: string, options?: { agent?: string }): Promise<SkillSummary[]> {
    const projectRoots = await listProjectSkillsRoots(workingDirectory);
    const [projectSkillDirs, userSkillDirs, pluginSkillDirs, adminSkillDirs] = await Promise.all([
        Promise.all(projectRoots.map(async (root) => await listTopLevelSkillDirs(root))).then((dirs) => dirs.flat()),
        Promise.all(getUserSkillsRoots().map(async (root) => await listTopLevelSkillDirs(root))).then((dirs) => dirs.flat()),
        options?.agent === 'codex' ? listCodexPluginSkillDirs() : Promise.resolve([]),
        listTopLevelSkillDirs(getAdminSkillsRoot()),
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
