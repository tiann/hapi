import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CREATABLE_AGENT_FLAVORS } from '@hapi/protocol/modes'
import { listSkills, resolveSkill } from './skills'
import {
    HAPI_SESSION_CONTROL_SKILL_DESCRIPTION,
    HAPI_SESSION_CONTROL_SKILL_NAME,
    ensureHapiSessionControlSkill,
    nativeSkillRoot
} from './hapiSessionControlSkill'

const ENV_KEYS = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GROK_HOME', 'DSH_HOME', 'OPENCODE_CONFIG_DIR'] as const

describe('canonical hapi-session-control delivery', () => {
    let sandbox: string
    let workingDirectory: string
    let originalEnv: Partial<Record<typeof ENV_KEYS[number], string | undefined>>

    beforeEach(async () => {
        sandbox = await mkdtemp(join(tmpdir(), 'hapi-session-control-'))
        workingDirectory = join(sandbox, 'repo')
        await mkdir(join(workingDirectory, '.git'), { recursive: true })
        originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
        process.env.HOME = join(sandbox, 'home')
        delete process.env.USERPROFILE
        delete process.env.CLAUDE_CONFIG_DIR
        delete process.env.CODEX_HOME
        delete process.env.GROK_HOME
        delete process.env.DSH_HOME
        delete process.env.OPENCODE_CONFIG_DIR
    })

    afterEach(async () => {
        for (const key of ENV_KEYS) {
            const value = originalEnv[key]
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
        await rm(sandbox, { recursive: true, force: true })
    })

    it.each(CREATABLE_AGENT_FLAVORS)('installs and verifies the %s runtime catalog on this host', async (flavor) => {
        const target = await ensureHapiSessionControlSkill(flavor, workingDirectory)
        expect(target).toBe(join(nativeSkillRoot(flavor), HAPI_SESSION_CONTROL_SKILL_NAME, 'SKILL.md'))
        expect(await readFile(target, 'utf8')).toContain(`name: ${HAPI_SESSION_CONTROL_SKILL_NAME}`)

        const catalog = await listSkills(workingDirectory, { flavor })
        expect(catalog).toContainEqual({
            name: HAPI_SESSION_CONTROL_SKILL_NAME,
            description: HAPI_SESSION_CONTROL_SKILL_DESCRIPTION
        })
        const loaded = await resolveSkill(HAPI_SESSION_CONTROL_SKILL_NAME, workingDirectory, { flavor })
        expect(loaded?.body).toContain('## Safety invariant')
    })

    it('fails closed when a project skill shadows the canonical body', async () => {
        const shadowDir = join(workingDirectory, '.agents', 'skills', HAPI_SESSION_CONTROL_SKILL_NAME)
        await mkdir(shadowDir, { recursive: true })
        await writeFile(join(shadowDir, 'SKILL.md'), [
            '---',
            `name: ${HAPI_SESSION_CONTROL_SKILL_NAME}`,
            `description: ${HAPI_SESSION_CONTROL_SKILL_DESCRIPTION}`,
            '---',
            '',
            'Unsafe replacement.'
        ].join('\n'))

        await expect(ensureHapiSessionControlSkill('codex', workingDirectory)).rejects.toThrow(/shadowed/)
    })

    it('updates only a HAPI-managed skill copy', async () => {
        const target = await ensureHapiSessionControlSkill('codex', workingDirectory)
        await writeFile(target, 'stale HAPI copy')

        await ensureHapiSessionControlSkill('codex', workingDirectory)

        expect(await readFile(target, 'utf8')).toContain('name: hapi-session-control')
        expect(await readFile(join(target, '..', '.hapi-managed'), 'utf8')).toBe(HAPI_SESSION_CONTROL_SKILL_NAME)
    })

    it('serializes concurrent first-time installs through the shared cross-process lock', async () => {
        const [first, second] = await Promise.all([
            ensureHapiSessionControlSkill('codex', workingDirectory),
            ensureHapiSessionControlSkill('codex', workingDirectory)
        ])

        expect(second).toBe(first)
        expect(await readFile(first, 'utf8')).toContain('name: hapi-session-control')
    })

    it('rejects an unmanaged skill file without overwriting it', async () => {
        const target = join(nativeSkillRoot('codex'), HAPI_SESSION_CONTROL_SKILL_NAME, 'SKILL.md')
        await mkdir(join(nativeSkillRoot('codex'), HAPI_SESSION_CONTROL_SKILL_NAME), { recursive: true })
        await writeFile(target, 'user-managed skill')

        await expect(ensureHapiSessionControlSkill('codex', workingDirectory)).rejects.toThrow(/user-managed/)

        expect(await readFile(target, 'utf8')).toBe('user-managed skill')
    })

    it('rejects a skill file symlink without overwriting its source', async () => {
        const source = join(sandbox, 'managed-skill.md')
        const targetDir = join(nativeSkillRoot('codex'), HAPI_SESSION_CONTROL_SKILL_NAME)
        const target = join(targetDir, 'SKILL.md')
        await mkdir(targetDir, { recursive: true })
        await writeFile(source, 'user-managed source')
        await symlink(source, target)

        await expect(ensureHapiSessionControlSkill('codex', workingDirectory)).rejects.toThrow(/symlink/)

        expect((await lstat(target)).isSymbolicLink()).toBe(true)
        expect(await readFile(source, 'utf8')).toBe('user-managed source')
    })

    it('rejects a skill directory symlink without overwriting its source', async () => {
        const managedDir = join(sandbox, 'managed-skill')
        const targetDir = join(nativeSkillRoot('codex'), HAPI_SESSION_CONTROL_SKILL_NAME)
        await mkdir(managedDir, { recursive: true })
        await writeFile(join(managedDir, 'SKILL.md'), 'user-managed source')
        await mkdir(nativeSkillRoot('codex'), { recursive: true })
        await symlink(managedDir, targetDir)

        await expect(ensureHapiSessionControlSkill('codex', workingDirectory)).rejects.toThrow(/symlink/)

        expect((await lstat(targetDir)).isSymbolicLink()).toBe(true)
        expect(await readFile(join(managedDir, 'SKILL.md'), 'utf8')).toBe('user-managed source')
    })
})
