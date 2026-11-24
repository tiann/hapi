import React from 'react'
import ReactDOM from 'react-dom/client'
import type { ContextDetails } from '@hapi/protocol'
import '../src/index.css'
import { StatusBar } from '../src/components/AssistantChat/StatusBar'
import { ContextDetailsDialog } from '../src/components/AssistantChat/ContextDetailsDialog'
import { I18nProvider } from '../src/lib/i18n-context'

const params = new URLSearchParams(location.search)
const isClaude = params.get('provider') === 'claude'
const details: ContextDetails = isClaude
    ? { version: 1, updatedAt: 1, provider: 'claude', claude: {
        skills: params.has('emptyRuntime') || params.has('restoredCommand') ? [] : [{ name: 'automatic-skill' }],
        systemTools: [],
        slashCommands: params.has('restoredCommand') ? ['/compact', '/review'] : ['/compact']
    } }
    : { version: 1, updatedAt: 1, provider: 'codex', codex: {
        mcpServers: params.has('knownNamesOnly') ? [{ name: 'docs' }] : [{ name: 'runtime-only', status: 'disabled', toolNames: [] }],
        slashCommands: params.has('customAgent') ? ['/compact', '/agent'] : ['/compact']
    } }

ReactDOM.createRoot(document.getElementById('root')!).render(
    <I18nProvider>
        {params.has('legacyMcp') ? <div data-testid="legacy-claude-mcp" className="m-4">
            <StatusBar active thinking={false} agentState={null} agentFlavor="claude"
                contextDetails={{ ...details, claude: {} }} legacyTools={['Read', 'mcp__hapi__list_peers']} />
        </div> : params.has('savedClaudeAlias') ? <div data-testid="saved-claude-alias-usage" className="m-4">
            <StatusBar active thinking={false} agentState={null} agentFlavor="claude" model="sonnet"
                contextDetails={{ ...details, model: 'claude-sonnet-4-5', contextWindow: 1_000_000, usage: { contextTokens: 100_000 } }} />
        </div> : params.has('savedUsage') ? <div data-testid="saved-codex-usage" className="m-4">
            <StatusBar active thinking={false} agentState={null} agentFlavor="codex" model="configured-model" contextModel="configured-model"
                contextDetails={{ ...details, model: 'actual-turn-model', contextWindow: 200_000, usage: { contextTokens: 80_000 } }} />
        </div> : <ContextDetailsDialog details={details} triggerClassName="m-4 p-2" triggerContent="Agent details" triggerAriaLabel="Open agent details" />}
    </I18nProvider>
)
