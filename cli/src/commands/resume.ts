import chalk from 'chalk'
import React from 'react'
import { render } from 'ink'
import { existsSync } from 'node:fs'
import type { LocalResumeTarget, ResumableSession } from '@hapi/protocol'
import type {
    ClaudePermissionMode,
    CodexPermissionMode,
    CursorPermissionMode,
    GrokPermissionMode,
    KimiPermissionMode,
    OpencodePermissionMode
} from '@hapi/protocol/types'
import { ApiClient } from '@/api/api'
import type { ReasoningEffort } from '@/codex/appServerTypes'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import { assertCodexLocalSupported } from '@/codex/utils/codexVersion'
import { ResumeSessionPicker } from '@/ui/ink/ResumeSessionPicker'
import type { CommandDefinition } from './types'

function formatSessionLine(session: ResumableSession, index: number): string {
    const name = session.name ?? session.summary ?? session.sessionId
    const state = session.active
        ? session.controlledByUser ? 'local' : 'remote'
        : 'inactive'
    return `${index + 1}. ${session.flavor.padEnd(8)} ${state.padEnd(8)} ${name}  ${session.directory}`
}

async function selectSession(sessions: ResumableSession[]): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
        let settled = false
        const complete = (callback: () => void) => {
            if (settled) return
            settled = true
            instance.unmount()
            callback()
        }
        const instance = render(React.createElement(ResumeSessionPicker, {
            sessions,
            onSelect: (sessionId: string) => complete(() => resolve(sessionId)),
            onCancel: () => complete(() => reject(new Error('Selection cancelled')))
        }), {
            patchConsole: false,
            exitOnCtrlC: false
        })
    })
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
            modelReasoningEffort: (target.modelReasoningEffort ?? undefined) as ReasoningEffort | undefined,
            collaborationMode: target.collaborationMode
        })
        return
    }

    if (target.flavor === 'gemini') {
        throw new Error('Gemini CLI is no longer supported and cannot be resumed (Google sunset the consumer Gemini CLI on 2026-06-18). The session history remains viewable in the web UI.')
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

    if (target.flavor === 'grok') {
        const { runGrok } = await import('@/grok/runGrok')
        await runGrok({
            existingSessionId: base.existingSessionId,
            workingDirectory: base.workingDirectory,
            resumeSessionId: base.resumeSessionId,
            startedBy: base.startedBy,
            permissionMode: base.permissionMode as GrokPermissionMode | undefined,
            startingMode: 'local',
            model: target.model ?? undefined,
            effort: target.effort ?? undefined
        })
        return
    }

    if (target.flavor === 'kimi') {
        const { runKimi } = await import('@/kimi/runKimi')
        await runKimi({
            existingSessionId: base.existingSessionId,
            workingDirectory: base.workingDirectory,
            resumeSessionId: base.resumeSessionId,
            startedBy: base.startedBy,
            permissionMode: base.permissionMode as KimiPermissionMode | undefined,
            startingMode: 'local',
            model: target.model ?? undefined
        })
        return
    }

    if (target.flavor === 'pi') {
        const { runPi } = await import('@/pi/runPi')
        await runPi({
            existingSessionId: base.existingSessionId,
            workingDirectory: base.workingDirectory,
            resumeSessionId: base.resumeSessionId,
            startedBy: base.startedBy,
            // Pi runs as `pi --mode rpc` with piped stdio and no local TUI input
            // path, so 'local' would advertise local-control that cannot be used
            // and hide/reject remote-only controls until a web switch.
            startingMode: 'remote',
            model: target.model ?? undefined,
            effort: target.effort ?? undefined,
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

            // Gemini CLI is no longer launchable (Google sunset the consumer
            // Gemini CLI on 2026-06-18). Reject BEFORE the handoff below so an
            // active Gemini session is left running/readable rather than being
            // stopped by handoffSessionToLocal and then failing locally.
            if (target.flavor === 'gemini') {
                throw new Error('Gemini CLI is no longer supported and cannot be resumed (Google sunset the consumer Gemini CLI on 2026-06-18). The session history remains viewable in the web UI.')
            }

            if (target.active && target.controlledByUser) {
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
