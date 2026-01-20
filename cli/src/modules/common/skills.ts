import { readdir, readFile } from 'fs/promises';
import { join, basename } from 'path';
import { homedir } from 'os';
import { parse as parseYaml } from 'yaml';

export interface SkillSummary {
    name: string;
    description?: string;
}

export interface ListSkillsRequest {
}

export interface ListSkillsResponse {
    success: boolean;
    skills?: SkillSummary[];
    error?: string;
}

function getSkillsRoot(): string {
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
    return join(codexHome, 'skills');
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

async function listTopLevelSkillDirs(skillsRoot: string): Promise<string[]> {
    try {
        const entries = await readdir(skillsRoot, { withFileTypes: true });
        const result: string[] = [];

        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }

            if (entry.name === '.system') {
                const systemRoot = join(skillsRoot, entry.name);
                try {
                    const systemEntries = await readdir(systemRoot, { withFileTypes: true });
                    for (const systemEntry of systemEntries) {
                        if (!systemEntry.isDirectory()) {
                            continue;
                        }
                        result.push(join(systemRoot, systemEntry.name));
                    }
                } catch {
                    // ignore unreadable .system
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

export async function listSkills(): Promise<SkillSummary[]> {
    const skillsRoot = getSkillsRoot();
    const skillDirs = await listTopLevelSkillDirs(skillsRoot);
    if (skillDirs.length === 0) {
        return [];
    }

    const skills = await Promise.all(skillDirs.map(async (dir): Promise<SkillSummary | null> => {
        const filePath = join(dir, 'SKILL.md');
        try {
            const fileContent = await readFile(filePath, 'utf-8');
            return extractSkillSummary(dir, fileContent);
        } catch {
            return null;
        }
    }));

    return skills
        .filter((skill): skill is SkillSummary => skill !== null)
        .sort((a, b) => a.name.localeCompare(b.name));
}

