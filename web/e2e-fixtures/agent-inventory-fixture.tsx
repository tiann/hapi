import React from 'react'
import ReactDOM from 'react-dom/client'
import type { ContextDetails } from '@hapi/protocol'
import '../src/index.css'
import { StatusBar } from '../src/components/AssistantChat/StatusBar'
import { ContextDetailsDialog } from '../src/components/AssistantChat/ContextDetailsDialog'
import { I18nProvider } from '../src/lib/i18n-context'

const params = new URLSearchParams(location.search)
const isClaude = params.get('provider') === 'claude'
const plainClaudeResume = params.has('plainClaudeResume')
const claudeSampleOrdering = params.get('claudeSampleOrdering')
const details: ContextDetails = isClaude
    ? { version: 1, updatedAt: 1, provider: 'claude', claude: {
        skills: params.has('emptyRuntime') || params.has('restoredCommand') ? [] : [{ name: 'automatic-skill' }],
        systemTools: [],
        slashCommands: params.has('restoredCommand') ? ['/compact', '/review'] : ['/compact']
    } }
    : { version: 1, updatedAt: 1, provider: 'codex', codex: {
        mcpServers: params.has('knownNamesOnly') ? [{ name: 'docs' }] : [{ name: 'runtime-only', status: 'disabled', toolNames: ['old-search'] },
            { name: 'ready-server', status: 'connected', toolNames: ['fresh-search'] }],
        slashCommands: params.has('customAgent') ? ['/compact', '/agent'] : ['/compact']
    } }

function ClaudeRewindUsageFixture() {
    const [rewound, setRewound] = React.useState(false)
    return <div className="m-4">
        <button onClick={() => setRewound(true)}>Apply committed rewind</button>
        <StatusBar active thinking={false} agentState={null} agentFlavor="claude" model="claude-sonnet-4-6"
            contextModel="claude-sonnet-4-6" contextSize={40_000} contextWindow={190_000} contextSampledAt={1000}
            contextDetails={{ ...details, model: 'claude-sonnet-4-6', ...(rewound ? {} : {
                contextWindow: 400_000, usage: { contextTokens: 120_000, sampledAt: 2000, sourceMessageUuid: 'rewound-answer' }
            }) }} />
    </div>
}

ReactDOM.createRoot(document.getElementById('root')!).render(
    <I18nProvider>
        {params.has('claudeRewindUsage') ? <ClaudeRewindUsageFixture /> : params.has('legacyMcp') ? <div data-testid="legacy-claude-mcp" className="m-4">
            <StatusBar active thinking={false} agentState={null} agentFlavor="claude"
                contextDetails={{ ...details, claude: {} }} legacyTools={['Read', 'mcp__hapi__list_peers']} />
        </div> : claudeSampleOrdering ? <div data-testid="claude-sample-ordering" className="m-4">
            <StatusBar active thinking={false} agentState={null} agentFlavor="claude"
                contextModel="claude-sonnet-4-6" contextSize={40_000} contextCacheRead={2_000}
                contextSampledAt={claudeSampleOrdering === 'metadata-newer' ? 1000 : 3000}
                contextDetails={{ ...details, model: 'claude-sonnet-4-6', contextWindow: 400_000,
                    usage: { contextTokens: 120_000, cacheReadTokens: 8_000, sampledAt: 2000 } }} />
        </div> : (params.has('savedClaudeAlias') || plainClaudeResume) ? <div data-testid="saved-claude-alias-usage" className="m-4">
            <StatusBar active thinking={false} agentState={null} agentFlavor="claude" model="sonnet"
                contextDetails={{ ...details, model: 'claude-sonnet-4-6',
                    ...(plainClaudeResume ? {} : { contextWindow: 1_000_000 }), usage: { contextTokens: 100_000 } }} />
        </div> : params.has('savedUsage') ? <div data-testid="saved-codex-usage" className="m-4">
            <StatusBar active thinking={false} agentState={null} agentFlavor="codex" model="configured-model" contextModel="configured-model"
                contextDetails={{ ...details, model: 'actual-turn-model', contextWindow: 200_000, usage: { contextTokens: 80_000 } }} />
        </div> : <ContextDetailsDialog details={details} triggerClassName="m-4 p-2" triggerContent="Agent details" triggerAriaLabel="Open agent details" />}
    </I18nProvider>
)
