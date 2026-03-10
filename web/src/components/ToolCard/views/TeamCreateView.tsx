import type { ToolViewComponent, ToolViewProps } from '@/components/ToolCard/views/_all'
import { isObject } from '@hapi/protocol'
import { basename } from '@/utils/path'

type TeamCreateInput = {
    teamName: string | null
    description: string | null
}

type TeamCreateResult = {
    teamName: string | null
    teamFilePath: string | null
    leadAgentId: string | null
}

function parseTeamCreateInput(value: unknown): TeamCreateInput {
    if (!isObject(value)) {
        return { teamName: null, description: null }
    }

    return {
        teamName: typeof value.team_name === 'string' ? value.team_name : null,
        description: typeof value.description === 'string' ? value.description : null
    }
}

function parseTeamCreateResult(value: unknown): TeamCreateResult {
    if (!isObject(value)) {
        return { teamName: null, teamFilePath: null, leadAgentId: null }
    }

    return {
        teamName: typeof value.team_name === 'string' ? value.team_name : null,
        teamFilePath: typeof value.team_file_path === 'string' ? value.team_file_path : null,
        leadAgentId: typeof value.lead_agent_id === 'string' ? value.lead_agent_id : null
    }
}

export function TeamCreateView(props: ToolViewProps) {
    const input = parseTeamCreateInput(props.block.tool.input)
    const result = parseTeamCreateResult(props.block.tool.result)
    const renamed = Boolean(result.teamName && input.teamName && result.teamName !== input.teamName)

    if (!renamed && !result.leadAgentId && !result.teamFilePath) {
        return null
    }

    return (
        <div className="flex flex-col gap-1.5 text-sm">
            {renamed ? (
                <div className="text-[var(--app-hint)]">
                    Effective team name: <span className="font-medium text-[var(--app-fg)]">{result.teamName}</span>
                </div>
            ) : null}
            {result.leadAgentId ? (
                <div className="text-[var(--app-hint)]">
                    Lead: <span className="font-mono text-xs">{result.leadAgentId}</span>
                </div>
            ) : null}
            {result.teamFilePath ? (
                <div className="text-[var(--app-hint)]">
                    Config: <span className="font-mono text-xs">{basename(result.teamFilePath)}</span>
                </div>
            ) : null}
        </div>
    )
}

function placeholderForState(state: ToolViewProps['block']['tool']['state']): string {
    if (state === 'pending') return 'Waiting for permission…'
    if (state === 'running') return 'Creating team…'
    if (state === 'completed') return 'Team created'
    return '(no output)'
}

export const TeamCreateResultView: ToolViewComponent = (props: ToolViewProps) => {
    const result = parseTeamCreateResult(props.block.tool.result)
    const input = parseTeamCreateInput(props.block.tool.input)
    const teamName = result.teamName ?? input.teamName

    if (!teamName && !result.teamFilePath && !result.leadAgentId) {
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    return (
        <div className="flex flex-col gap-1.5 text-sm">
            {teamName ? (
                <div className="text-[var(--app-fg)]">
                    Created team <span className="font-medium">{teamName}</span>
                </div>
            ) : null}
            {result.leadAgentId ? (
                <div className="text-[var(--app-hint)]">
                    Lead agent: <span className="font-mono text-xs">{result.leadAgentId}</span>
                </div>
            ) : null}
            {result.teamFilePath ? (
                <div className="text-[var(--app-hint)]">
                    Team config: <span className="font-mono text-xs break-all">{result.teamFilePath}</span>
                </div>
            ) : null}
        </div>
    )
}
