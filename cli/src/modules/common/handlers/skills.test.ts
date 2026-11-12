import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { RpcHandlerManager } from '../../../api/rpc/RpcHandlerManager'
import { registerSkillsHandlers } from './skills'

const SCOPE = 'session-test'

async function writeSkill(skillDir: string, name: string, description: string): Promise<void> {
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), [
        '---',
        `name: ${name}`,
        `description: ${description}`,
        '---',
        '',
        `# ${name}`
    ].join('\n'))
}

interface ListSkillsHandlerResult {
    success: boolean
    skills?: Array<{ name: string; description?: string }>
    error?: string
}

describe('skills RPC handlers', () => {
    const originalHome = process.env.HOME
    const originalBerryDataDir = process.env.BERRY_AGENT_DATA_DIR
    let sandboxDir: string
    let homeDir: string
    let rpc: RpcHandlerManager

    beforeEach(async () => {
        sandboxDir = await mkdtemp(join(tmpdir(), 'hapi-skills-handler-'))
        homeDir = join(sandboxDir, 'home')
        process.env.HOME = homeDir
        delete process.env.BERRY_AGENT_DATA_DIR
        await mkdir(homeDir, { recursive: true })
        rpc = new RpcHandlerManager({ scopePrefix: SCOPE })
    })

    afterEach(async () => {
        if (originalHome === undefined) {
            delete process.env.HOME
        } else {
            process.env.HOME = originalHome
        }
        if (originalBerryDataDir === undefined) {
            delete process.env.BERRY_AGENT_DATA_DIR
        } else {
            process.env.BERRY_AGENT_DATA_DIR = originalBerryDataDir
        }
        await rm(sandboxDir, { recursive: true, force: true })
    })

    async function requestListSkills(params: { flavor?: string }): Promise<ListSkillsHandlerResult> {
        const response = await rpc.handleRequest({
            method: `${SCOPE}:${RPC_METHODS.ListSkills}`,
            params: JSON.stringify(params)
        })
        return JSON.parse(response) as ListSkillsHandlerResult
    }

    it('lists berry skills from the session data dir resolver instead of the interactive profile', async () => {
        // A berry session's spawned child runs on an isolated
        // BERRY_AGENT_DATA_DIR; its user-skills layer is <dataDir>/skills.
        // The handler must thread the session dir through so the listing
        // matches what the agent discovers, not ~/.berry-agent.
        const dataDir = join(sandboxDir, 'berry-data', 'row-1')
        await writeSkill(join(homeDir, '.berry-agent', 'skills', 'interactive'), 'interactive', 'Interactive skill')
        await writeSkill(join(dataDir, 'skills', 'isolated'), 'isolated', 'Isolated skill')
        registerSkillsHandlers(rpc, sandboxDir, { resolveBerryDataDir: () => dataDir })

        const result = await requestListSkills({ flavor: 'berry' })

        expect(result.success).toBe(true)
        expect(result.skills?.map((skill) => skill.name)).toEqual(['isolated'])
    })

    it('falls back to the interactive berry profile without a session resolver', async () => {
        await writeSkill(join(homeDir, '.berry-agent', 'skills', 'interactive'), 'interactive', 'Interactive skill')
        registerSkillsHandlers(rpc, sandboxDir)

        const result = await requestListSkills({ flavor: 'berry' })

        expect(result.success).toBe(true)
        expect(result.skills?.map((skill) => skill.name)).toEqual(['interactive'])
    })

    it('ignores the berry resolver for other flavors', async () => {
        // The resolver is berry-only plumbing: a claude-flavor request in
        // the same session process must keep reading ~/.claude/skills.
        const dataDir = join(sandboxDir, 'berry-data', 'row-1')
        await writeSkill(join(dataDir, 'skills', 'isolated'), 'isolated', 'Isolated skill')
        await writeSkill(join(homeDir, '.claude', 'skills', 'claude-user'), 'claude-user', 'Claude skill')
        registerSkillsHandlers(rpc, sandboxDir, { resolveBerryDataDir: () => dataDir })

        const result = await requestListSkills({ flavor: 'claude' })

        expect(result.success).toBe(true)
        expect(result.skills?.map((skill) => skill.name)).toEqual(['claude-user'])
    })
})
