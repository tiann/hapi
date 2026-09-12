import { CREATABLE_AGENT_FLAVORS, getFlavorLabel } from '@hapi/protocol'

export function printCliHelp(): void {
    const agents = [...CREATABLE_AGENT_FLAVORS].sort().map((agent) => (
        `  ${`hapi ${agent}`.padEnd(26)} ${getFlavorLabel(agent)}`
    )).join('\n')

    console.log(`HAPI - Coding agents with remote control

Usage:
  hapi                       Choose an agent interactively
  hapi <agent> [options]      Start an agent session
  hapi <command> [options]    Run a HAPI command

Agents:
${agents}

Commands:
  hapi auth                  Manage authentication
  hapi resume [id]           Choose or resume an existing HAPI session
  hapi hub [--relay]         Start the API + web hub
  hapi server                Alias for hapi hub
  hapi runner                Manage the background runner
  hapi doctor                Run diagnostics and troubleshooting
  hapi ping-peer             List peers or message another session
  hapi inspect-peer <id>     Read another session's metadata and messages
  hapi mcp                   Start the MCP stdio bridge

Options:
  -h, --help                 Show HAPI help
  -v, --version              Show HAPI version

Examples:
  hapi                       Choose an installed agent
  hapi claude --resume       Resume a Claude session
  hapi codex --yolo          Start Codex with automatic approvals
  hapi auth login            Configure authentication

Agent options belong after the agent name; supported options vary by agent.
Scripts and non-interactive shells must specify an agent explicitly.`)
}
