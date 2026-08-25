import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import {
    CREATABLE_AGENT_FLAVORS,
    type AgentAvailabilityEntry,
    type AgentAvailabilityResponse,
    type AgentFlavor,
} from '@hapi/protocol'
import { getDefaultClaudeCodePath } from '@/claude/sdk/utils'
import { resolveCodexCommand } from '@/codex/utils/codexExecutable'
import { resolveDshAcpCommand } from '@/dsh/utils/dshBackend'
import { getAgentLaunchCommand, resolveExecutable } from './agentLaunchCommand'

type LaunchEnvironment = Record<string, string | undefined>

type AgentLaunchSpec = {
    command: string
    args: string[]
}

function resolveLaunchSpec(agent: AgentFlavor, env: LaunchEnvironment): AgentLaunchSpec {
    if (agent === 'claude') {
        return { command: getDefaultClaudeCodePath(env), args: [] }
    }
    if (agent === 'codex') {
        // Remote Codex sessions launch app-server through this explicit
        // override. Validate the same command the session will actually use,
        // rather than falling back to an unrelated PATH/Desktop install.
        if (env.HAPI_CODEX_APP_SERVER_BIN) {
            return { command: env.HAPI_CODEX_APP_SERVER_BIN.trim(), args: [] }
        }
        return resolveCodexCommand(env)
    }
    if (agent === 'dsh') {
        return resolveDshAcpCommand(env)
    }
    return { command: getAgentLaunchCommand(agent, env), args: [] }
}

function hasValidDshConfiguration(env: LaunchEnvironment): boolean {
    const config = env.HAPI_DSH_ACP_CONFIG?.trim()
    if (!config) return true
    if (!isAbsolute(config)) return false
    try {
        return existsSync(config) && statSync(config).isFile()
    } catch {
        return false
    }
}

function hasResolvableCommand(spec: AgentLaunchSpec, env: LaunchEnvironment): boolean {
    const executable = resolveExecutable(spec.command, {
        pathValue: env.PATH,
        pathExt: env.PATHEXT,
    })
    if (!executable) return false

    // Windows Codex npm shims resolve to `node <absolute codex.js>`.
    const script = spec.args[0]
    if (script && isAbsolute(script)) {
        try {
            return existsSync(script) && statSync(script).isFile()
        } catch {
            return false
        }
    }
    return true
}

export function getAgentAvailability(
    agent: AgentFlavor,
    env: LaunchEnvironment = process.env,
): AgentAvailabilityEntry {
    if (agent === 'gemini') {
        return { agent, available: false, reason: 'not_found' }
    }

    let spec: AgentLaunchSpec
    try {
        spec = resolveLaunchSpec(agent, env)
        if (agent === 'dsh' && !hasValidDshConfiguration(env)) {
            return { agent, available: false, reason: 'invalid_configuration' }
        }
    } catch {
        // Claude's resolver throws when the default command is simply absent;
        // that is an installation miss, not malformed static configuration.
        return {
            agent,
            available: false,
            reason: agent === 'claude' ? 'not_found' : 'invalid_configuration',
        }
    }

    if (hasResolvableCommand(spec, env)) {
        return { agent, available: true }
    }
    return {
        agent,
        available: false,
        reason: agent === 'codex' && Boolean(env.HAPI_CODEX_APP_SERVER_BIN)
            ? 'invalid_configuration'
            : 'not_found',
    }
}

export function getAgentAvailabilityResponse(
    env: LaunchEnvironment = process.env,
): AgentAvailabilityResponse {
    return {
        agents: CREATABLE_AGENT_FLAVORS.map((agent) => getAgentAvailability(agent, env)),
    }
}

export function agentUnavailableMessage(entry: AgentAvailabilityEntry): string {
    const detail = entry.reason === 'invalid_configuration'
        ? 'has invalid runner configuration'
        : 'is not installed or is not on PATH'
    return `${entry.agent} ${detail}`
}
