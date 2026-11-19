import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ApiSessionClient } from '@/api/apiSession'
import { Session } from './session'
import { runClaude, type StartOptions } from './runClaude'
import { listSkills } from '@/modules/common/skills'
import { recordCatalog } from './catalogCache'
import { extractSDKMetadata, type SDKMetadata } from './sdk/metadataExtractor'
import { claudeRemoteLauncher } from './claudeRemoteLauncher'

const { bootstrap, versionProbe } = vi.hoisted(() => ({ bootstrap: vi.fn(), versionProbe: vi.fn() }))
vi.mock('node:child_process', async original => ({
    ...await original<typeof import('node:child_process')>(), execFileSync: versionProbe
}))
vi.mock('@/agent/sessionFactory', () => ({ bootstrapExistingSession: bootstrap, bootstrapSession: bootstrap }))
vi.mock('./claudeLocalLauncher', () => ({ claudeLocalLauncher: async (instance: Session) => { session = instance; return 'exit' } }))
vi.mock('./catalogCache', { spy: true })
vi.mock('./claudeRemoteLauncher', () => ({ claudeRemoteLauncher: vi.fn() }))
vi.mock('./sdk/metadataExtractor', async original => ({
    ...await original<typeof import('./sdk/metadataExtractor')>(), extractSDKMetadata: vi.fn()
}))
vi.mock('./sdk/utils', async original => ({
    ...await original<typeof import('./sdk/utils')>(), getDefaultClaudeCodePath: () => 'claude'
}))
vi.mock('@/modules/common/skills', async original => ({
    ...await original<typeof import('@/modules/common/skills')>(), listSkills: vi.fn(async () => [])
}))
vi.mock('./utils/startHappyServer', () => ({
    startHappyServer: async () => ({ url: 'http://localhost', toolNames: [] }), toClaudeAllowedHapiMcpTools: () => []
}))
vi.mock('./utils/startHookServer', () => ({ startHookServer: async () => ({ port: 1234 }) }))
vi.mock('@/modules/common/hooks/generateHookSettings', () => ({ generateHookSettingsFile: () => '/tmp/hooks' }))
vi.mock('@/agent/runnerLifecycle', () => ({
    createRunnerLifecycle: () => ({ registerProcessHandlers() {}, setSessionEndReason() {}, cleanupAndExit() {}, markCrash() {}, cleanup() {} }),
    createModeChangeHandler: vi.fn(), setControlledByUser: vi.fn()
}))

const path = process.cwd()
const initial = { tools: ['Read'], slashCommands: ['help'], path, host: 'test' }
const catalog = { version: '2.1.0', tools: ['Write'], slashCommands: ['new-command', 'skill'], skills: ['skill'] }
let id: string
let metadata: typeof initial
let receive: Parameters<ApiSessionClient['onUserMessage']>[0]
let cancel: Parameters<ApiSessionClient['onCancelQueuedMessage']>[0]
let session: Session
let liveCatalog: Parameters<typeof claudeRemoteLauncher>[1]
const registerHandler = vi.fn()
const discard = vi.fn()
const updateMetadata = vi.fn((fn: (current: typeof metadata) => typeof metadata) => { metadata = fn(metadata) })

function send(text: string, localId: string) {
    receive({ role: 'user', content: { type: 'text', text } }, localId)
}
function messages() {
    return session.queue.queue.map(item => item.message)
}
async function reopen(options: StartOptions = {}) {
    await runClaude({ existingSessionId: id, startedBy: 'runner', workingDirectory: path, ...options })
    send('ready', 'ready')
    await vi.waitFor(() => expect(messages()).toContain('ready'))
}
beforeEach(() => {
    vi.clearAllMocks()
    id = randomUUID()
    metadata = { ...initial }
    recordCatalog(id, { cwd: path }, metadata, catalog.version, [{ name: 'skill', description: 'cached description' }])
    versionProbe.mockReturnValue(catalog.version + ' (Claude Code)')
    vi.mocked(extractSDKMetadata).mockResolvedValue(catalog)
    bootstrap.mockImplementation(async () => ({
        api: {}, sessionInfo: { id, metadata }, session: {
            rpcHandlerManager: { registerHandler }, keepAlive: vi.fn(), on: vi.fn(),
            discardPendingHubPromptEcho: discard,
            updateMetadata, getMetadata: () => metadata, onReconnect: vi.fn(),
            onUserMessage: (fn: typeof receive) => { receive = fn },
            onCancelQueuedMessage: (fn: typeof cancel) => { cancel = fn }
        }
    }))
    vi.mocked(claudeRemoteLauncher).mockImplementation(async (instance, callback) => {
        session = instance
        liveCatalog = callback
        return 'exit'
    })
})
afterEach(() => {
    session?.stopKeepAlive()
    recordCatalog(id, { cwd: path }, {})
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
})

it('refreshes removed commands on a terminal local reopen with a valid stamp', async () => {
    await runClaude({ existingSessionId: id, startedBy: 'terminal', startingMode: 'local', workingDirectory: path })
    expect(extractSDKMetadata).toHaveBeenCalledOnce()
    expect(extractSDKMetadata).toHaveBeenCalledBefore(versionProbe)
    await vi.waitFor(() => expect(metadata.slashCommands).toEqual(['new-command']))
})

it('serves ListSkills and expands the first skill prompt from a valid reopen cache', async () => {
    await reopen()
    const handler = registerHandler.mock.calls.find(([name]) => name === RPC_METHODS.ListSkills)![1]
    expect(await handler()).toEqual({ success: true, skills: [{ name: 'skill', description: 'cached description' }] })
    send('$skill first', 'a')
    expect(messages()).toEqual(['ready', '/skill first'])
    expect(extractSDKMetadata).not.toHaveBeenCalled()
})
it.each(['version', 'model', 'args', 'plugin', 'empty tools', 'empty commands', 'cwd', '24 hours', 'missing stamp', 'profile'])(
    'refreshes the startup catalog on %s', async reason => {
        const options: StartOptions = {}
        if (reason === 'version') versionProbe.mockReturnValue('2.2.0')
        if (reason === 'model') options.model = 'sonnet'
        if (reason === 'profile') vi.stubEnv('CLAUDE_CONFIG_DIR', path + '/other-profile')
        if (reason === 'args') options.claudeArgs = ['--verbose']
        if (reason === 'plugin') options.claudeArgs = ['--plugin-dir', '/tmp/plugin']
        if (reason === 'empty tools') metadata.tools = []
        if (reason === 'empty commands') metadata.slashCommands = []
        if (reason === 'cwd') metadata.path += '/other'
        if (reason === '24 hours') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 86_400_000)
        if (reason === 'missing stamp') recordCatalog(id, { cwd: path }, {})
        await reopen(options)
        expect(extractSDKMetadata).toHaveBeenCalledExactlyOnceWith({
            cwd: path, model: options.model, claudeArgs: options.claudeArgs
        })
    }
)
it('refreshes metadata and native skill names from a real launch callback without another probe', async () => {
    await reopen()
    liveCatalog!(catalog)
    await vi.waitFor(() => expect(metadata.slashCommands).toEqual(['new-command']))
    expect(metadata.tools).toEqual(['Write'])
    send('$skill live', 'a')
    expect(messages()).toEqual(['ready', '/skill live'])
    expect(extractSDKMetadata).not.toHaveBeenCalled()
})

it('keeps the live catalog when an older skill probe finishes late', async () => {
    recordCatalog(id, { cwd: path }, {})
    let finish!: (value: SDKMetadata) => void
    vi.mocked(extractSDKMetadata).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    await runClaude({ existingSessionId: id, startedBy: 'runner', workingDirectory: path })
    send('$skill', 'a')
    liveCatalog!(catalog)
    await vi.waitFor(() => expect(metadata.tools).toEqual(['Write']))
    finish({ tools: ['Read'], slashCommands: ['old'], skills: [] })
    await vi.waitFor(() => expect(messages()).toEqual(['/skill']))
    expect(metadata.slashCommands).toEqual(['new-command'])
})

it.each([
    ['--resume', randomUUID()],
    ['--resume', randomUUID(), '--fork-session'],
    ['--continue'],
    ['--resume', '--fork-session']
])('reuses a fresh-session stamp on a runner reopen with %j', async (...claudeArgs) => {
    await reopen({ claudeArgs })
    expect(versionProbe.mock.calls.filter(([, args]) => args?.[0] === '--version')).toHaveLength(1)
    expect(extractSDKMetadata).not.toHaveBeenCalled()
})

it.each([
    ['--resume', '--verbose'],
    ['--', '--continue']
])('keeps persistent arguments in the fingerprint for %j', async (...claudeArgs) => {
    await reopen({ claudeArgs })
    expect(extractSDKMetadata).toHaveBeenCalledOnce()
})

it('coalesces identical live inits and only publishes a changed catalog or launch context', async () => {
    await reopen()
    vi.mocked(recordCatalog).mockClear()
    updateMetadata.mockClear()
    const resume = ['--resume', randomUUID()]
    liveCatalog!(catalog, undefined, resume)
    liveCatalog!({ ...catalog })
    await vi.waitFor(() => expect(metadata.tools).toEqual(['Write']))
    liveCatalog!({ ...catalog })
    await new Promise(resolve => setImmediate(resolve))
    expect(listSkills).toHaveBeenCalledOnce()
    expect(recordCatalog).toHaveBeenCalledOnce()
    expect(updateMetadata).toHaveBeenCalledOnce()

    const newSkill = { ...catalog, skills: ['other'], slashCommands: ['new-command', 'other'] }
    liveCatalog!(newSkill)
    await new Promise(resolve => setImmediate(resolve))
    send('$other', 'live-skill')
    expect(messages()).toContain('/other')
    expect(recordCatalog).toHaveBeenCalledTimes(2)
    expect(updateMetadata).toHaveBeenCalledOnce()

    liveCatalog!(newSkill, 'sonnet')
    await vi.waitFor(() => expect(updateMetadata).toHaveBeenCalledTimes(2))
    liveCatalog!({ ...newSkill, version: '2.2.0' }, 'sonnet')
    await vi.waitFor(() => expect(updateMetadata).toHaveBeenCalledTimes(3))
    liveCatalog!({ ...newSkill, version: '2.2.0', tools: ['Read'] }, 'sonnet')
    await vi.waitFor(() => expect(metadata.tools).toEqual(['Read']))
    expect(recordCatalog).toHaveBeenCalledTimes(5)
    expect(updateMetadata).toHaveBeenCalledTimes(4)
})
