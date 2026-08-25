import type { FixtureCase } from '../fixtureTypes'
import { T0, wireMessage } from './support'

/**
 * The hub head+tail-truncates strings over 64KB inside agent message content
 * at ingest, splicing in the `…[hapi: truncated N chars]…` marker
 * (hub/src/store/contentCodec.ts). Clients receive the marker verbatim inside
 * tool results — the pipeline must pass it through intact.
 */
export const truncationCases: FixtureCase[] = [
    {
        name: 'tool-result-truncation-marker',
        description: 'A tool_result containing the hub truncation marker (…[hapi: truncated N chars]…) passes through the pipeline byte-for-byte inside tool.result.',
        messages: [
            wireMessage({
                id: 'msg-agent-111',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'a1c8e359-2b6d-4f70-9c1e-d8f2a4b0c111',
                            parentUuid: null,
                            timestamp: '2025-08-12T11:20:00.412Z',
                            message: {
                                role: 'assistant',
                                model: 'claude-opus-4-1-20250805',
                                content: [
                                    {
                                        type: 'tool_use',
                                        id: 'toolu_01TrCtBuildLog',
                                        name: 'Bash',
                                        input: { command: 'cat build.log', description: 'Inspect the build log' }
                                    }
                                ]
                            }
                        }
                    }
                }
            }),
            wireMessage({
                id: 'msg-agent-112',
                seq: 2,
                createdAt: T0 + 1_800,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'user',
                            uuid: 'b2d9f460-3c7e-4a81-8d2f-e9a3b5c1d112',
                            parentUuid: 'a1c8e359-2b6d-4f70-9c1e-d8f2a4b0c111',
                            timestamp: '2025-08-12T11:20:01.933Z',
                            message: {
                                role: 'user',
                                content: [
                                    {
                                        type: 'tool_result',
                                        tool_use_id: 'toolu_01TrCtBuildLog',
                                        content: '[build] compiling 412 modules\n[build] step 1/9 …\n…[hapi: truncated 51200 chars]…\n[build] step 9/9 done\n[build] finished in 84.2s',
                                        is_error: false
                                    }
                                ]
                            }
                        }
                    }
                }
            })
        ]
    }
]
