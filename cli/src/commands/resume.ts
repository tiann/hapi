import chalk from 'chalk'
import { existsSync } from 'node:fs'
import * as readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import type { LocalResumeTarget, ResumableSession } from '@hapi/protocol'
import type {
    ClaudePermissionMode,
    CodexPermissionMode,
    CursorPermissionMode,
    GeminiPermissionMode,
    OpencodePermissionMode
} from '@hapi/protocol/types'
import { ApiClient } from '@/api/api'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import { assertCodexLocalSupported } from '@/codex/utils/codexVersion'
import type { CommandDefinition } from './types'

function formatSessionLine(session: ResumableSession, index: number): string {
    const name = session.name ?? session.summary ?? session.sessionId
    const state = session.active
        ? session.controlledByUser ? 'local' : 'remote'
        : 'inactive'
    return `${index + 1}. ${session.flavor.padEnd(8)} ${state.padEnd(8)} ${name}  ${session.directory}`
}

async function selectSession(sessions: ResumableSession[]): Promise<string> {
    console.log(chalk.bold('Resumable sessions'))
    console.log('')
    sessions.forEach((session, index) => {
        console.log(formatSessionLine(session, index))
    })
    console.log('')

    const rl = readline.createInterface({ input, output })
    try {
        const answer = await rl.question(chalk.cyan('Select session: '))
        const index = Number(answer.trim()) - 1
        if (!Number.isInteger(index) || index < 0 || index >= sessions.length) {
            throw new Error('Invalid selection')
        }
        return sessions[index].sessionId
    } finally {
        rl.close()
    }
}

function assertTargetMachine(target: LocalResumeTarget, machineId: string): void {
    if (!target.machineId) {
        throw new Error('Session metadata missing machine id')
    }
    if (target.machineId !== machineId) {
        throw new Error(`Session belongs to another machine (${target.machineId})`)
    }
}

function assertDirectoryExists(target: LocalResumeTarget): void {
    if (!existsSync(target.directory)) {
        throw new Error(`Session directory does not exist: ${target.directory}`)
    }
}

async function dispatchLocalResume(target: LocalResumeTarget): Promise<void> {
    const base = {
        existingSessionId: target.sessionId,
        workingDirectory: target.directory,
        resumeSessionId: target.agentSessionId,
        startedBy: 'terminal' as const,
        permissionMode: target.permissionMode
    }

    if (target.flavor === 'claude') {
        const { runClaude } = await import('@/claude/runClaude')
        await runClaude({
            existingSessionId: base.existingSessionId,
            workingDirectory: base.workingDirectory,
            resumeSessionId: base.resumeSessionId,
            startedBy: base.startedBy,
            permissionMode: base.permissionMode as ClaudePermissionMode | undefined,
            startingMode: 'local',
            model: target.model ?? undefined,
            effort: target.effort ?? undefined
        })
        return
    }

    if (target.flavor === 'codex') {
        assertCodexLocalSupported()
        const { runCodex } = await import('@/codex/runCodex')
        await runCodex({
            existingSessionId: base.existingSessionId,
            workingDirectory: base.workingDirectory,
            resumeSessionId: base.resumeSessionId,
            startedBy: base.startedBy,
            permissionMode: base.permissionMode as CodexPermissionMode | undefined,
            model: target.model ?? undefined,
            modelReasoningEffort: target.modelReasoningEffort ?? undefined
        })
        return
    }

    if (target.flavor === 'gemini') {
        const { runGemini } = await import('@/gemini/runGemini')
        await runGemini({
            existingSessionId: base.existingSessionId,
            workingDirectory: base.workingDirectory,
            resumeSessionId: base.resumeSessionId,
            startedBy: base.startedBy,
            permissionMode: base.permissionMode as GeminiPermissionMode | undefined,
            startingMode: 'local',
            model: target.model ?? undefined
        })
        return
    }

    if (target.flavor === 'opencode') {
        const { runOpencode } = await import('@/opencode/runOpencode')
        await runOpencode({
            existingSessionId: base.existingSessionId,
            workingDirectory: base.workingDirectory,
            resumeSessionId: base.resumeSessionId,
            startedBy: base.startedBy,
            permissionMode: base.permissionMode as OpencodePermissionMode | undefined,
            startingMode: 'local',
            model: target.model ?? undefined
        })
        return
    }

    const { runCursor } = await import('@/cursor/runCursor')
    await runCursor({
        existingSessionId: base.existingSessionId,
        workingDirectory: base.workingDirectory,
        resumeSessionId: base.resumeSessionId,
        startedBy: base.startedBy,
        permissionMode: base.permissionMode as CursorPermissionMode | undefined,
        model: target.model ?? undefined
    })
}

async function resolveSessionId(api: ApiClient, machineId: string, args: string[]): Promise<string> {
    const explicit = args[0]
    if (explicit) {
        return explicit
    }

    const sessions = await api.listResumableSessions(machineId)
    if (sessions.length === 0) {
        throw new Error('No resumable sessions found for this machine')
    }

    if (!process.stdin.isTTY) {
        for (const [index, session] of sessions.entries()) {
            console.log(formatSessionLine(session, index))
        }
        throw new Error('Run: hapi resume <session-id>')
    }

    return await selectSession(sessions)
}

export const resumeCommand: CommandDefinition = {
    name: 'resume',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            await initializeToken()
            await maybeAutoStartServer()
            const { machineId } = await authAndSetupMachineIfNeeded()
            const api = await ApiClient.create()
            const sessionId = await resolveSessionId(api, machineId, commandArgs)
            const target = await api.getLocalResumeTarget(sessionId)

            assertTargetMachine(target, machineId)
            assertDirectoryExists(target)

            if (target.controlledByUser) {
                throw new Error('Session is already controlled by a local terminal')
            }

            if (target.active) {
                await api.handoffSessionToLocal(target.sessionId)
            }

            await dispatchLocalResume(target)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}
