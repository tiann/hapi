/**
 * Tests for SDK to Log converter
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { SDKToLogConverter, convertSDKToLog } from './sdkToLogConverter'
import type { SDKMessage, SDKUserMessage, SDKAssistantMessage, SDKSystemMessage, SDKResultMessage } from '@/claude/sdk'
import type { ClaudePermissionMode } from '@hapi/protocol/types'

describe('SDKToLogConverter', () => {
    let converter: SDKToLogConverter
    const context = {
        sessionId: 'test-session-123',
        cwd: '/test/project',
        version: '1.0.0',
        gitBranch: 'main'
    }

    beforeEach(() => {
        converter = new SDKToLogConverter(context)
    })

    describe('User messages', () => {
        it('should convert SDK user message to log format', () => {
            const sdkMessage: SDKUserMessage = {
                type: 'user',
                message: {
                    role: 'user',
                    content: 'Hello Claude'
                }
            }

            const logMessage = converter.convert(sdkMessage)

            expect(logMessage).toBeTruthy()
            expect(logMessage?.type).toBe('user')
            expect(logMessage).toMatchObject({
                type: 'user',
                sessionId: context.sessionId,
                cwd: context.cwd,
                version: context.version,
                gitBranch: context.gitBranch,
                parentUuid: null,
                isSidechain: false,
                userType: 'external',
                message: {
                    role: 'user',
                    content: 'Hello Claude'
                }
            })
            expect(logMessage?.uuid).toBeTruthy()
            expect(logMessage?.timestamp).toBeTruthy()
        })

        it('should handle user message with complex content', () => {
            const sdkMessage: SDKUserMessage = {
                type: 'user',
                message: {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Check this out' },
                        { type: 'tool_result', tool_use_id: 'tool123', content: 'Result data' }
                    ]
                }
            }

            const logMessage = converter.convert(sdkMessage)

            expect(logMessage?.type).toBe('user')
            expect((logMessage as any).message.content).toHaveLength(2)
        })
    })

    describe('Assistant messages', () => {
        it('should convert SDK assistant message to log format', () => {
            const sdkMessage: SDKAssistantMessage = {
                type: 'assistant',
                message: {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'Hello! How can I help?' }
                    ]
                }
            }

            const logMessage = converter.convert(sdkMessage)

            expect(logMessage).toBeTruthy()
            expect(logMessage?.type).toBe('assistant')
            expect(logMessage).toMatchObject({
                type: 'assistant',
                sessionId: context.sessionId,
                message: {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'Hello! How can I help?' }
                    ]
                }
            })
        })

        it('should include requestId if present', () => {
            const sdkMessage: any = {
                type: 'assistant',
                message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'Response' }]
                },
                requestId: 'req_123'
            }

            const logMessage = converter.convert(sdkMessage)

            expect((logMessage as any).requestId).toBe('req_123')
        })
    })

    describe('System messages', () => {
        it('should convert SDK system message to log format', () => {
            const sdkMessage: SDKSystemMessage = {
                type: 'system',
                subtype: 'init',
                session_id: 'new-session-456',
                model: 'claude-opus-4',
                cwd: '/project',
                tools: ['bash', 'edit']
            }

            const logMessage = converter.convert(sdkMessage)

            expect(logMessage).toBeTruthy()
            expect(logMessage?.type).toBe('system')
            expect(logMessage).toMatchObject({
                type: 'system',
                subtype: 'init',
                model: 'claude-opus-4',
                tools: ['bash', 'edit']
            })
        })

        it('should update session ID on init system message', () => {
            const sdkMessage: SDKSystemMessage = {
                type: 'system',
                subtype: 'init',
                session_id: 'updated-session-789'
            }

            converter.convert(sdkMessage)

            // Next message should have updated session ID
            const userMessage: SDKUserMessage = {
                type: 'user',
                message: { role: 'user', content: 'Test' }
            }

            const logMessage = converter.convert(userMessage)
            expect(logMessage?.sessionId).toBe('updated-session-789')
        })
    })

    describe('Result messages', () => {
        it('should not convert result messages', () => {
            const sdkMessage: SDKResultMessage = {
                type: 'result',
                subtype: 'success',
                result: 'Task completed',
                num_turns: 5,
                usage: {
                    input_tokens: 100,
                    output_tokens: 200
                },
                total_cost_usd: 0.05,
                duration_ms: 3000,
                duration_api_ms: 2500,
                is_error: false,
                session_id: 'result-session'
            }

            const logMessage = converter.convert(sdkMessage)

            expect(logMessage).toBeNull()
        })

        it('should not convert error results', () => {
            const sdkMessage: SDKResultMessage = {
                type: 'result',
                subtype: 'error_max_turns',
                num_turns: 10,
                total_cost_usd: 0.1,
                duration_ms: 5000,
                duration_api_ms: 4500,
                is_error: true,
                session_id: 'error-session'
            }

            const logMessage = converter.convert(sdkMessage)

            // Error results are not converted to summaries
            expect(logMessage).toBeFalsy()
        })
    })

    describe('Context window propagation', () => {
        function makeAssistantMessage(): SDKAssistantMessage {
            return {
                type: 'assistant',
                message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'hi' }],
                    usage: {
                        input_tokens: 10,
                        output_tokens: 20,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0,
                        service_tier: 'standard'
                    }
                } as any
            }
        }

        it('infers 1M contextWindow from [1m] suffix on system.init', () => {
            const initMsg: SDKSystemMessage = {
                type: 'system',
                subtype: 'init',
                session_id: 'session-1',
                model: 'claude-opus-4-7[1m]'
            }
            converter.convert(initMsg)

            const assistantLog = converter.convert(makeAssistantMessage()) as any
            expect(assistantLog?.message?.usage?.context_window).toBe(1_000_000)
        })

        it('infers 200k contextWindow when [1m] suffix is absent', () => {
            const initMsg: SDKSystemMessage = {
                type: 'system',
                subtype: 'init',
                session_id: 'session-2',
                model: 'claude-sonnet-5'
            }
            converter.convert(initMsg)

            const assistantLog = converter.convert(makeAssistantMessage()) as any
            expect(assistantLog?.message?.usage?.context_window).toBe(200_000)
        })

        it('refines contextWindow from result.modelUsage and applies to later assistants', () => {
            const initMsg: SDKSystemMessage = {
                type: 'system',
                subtype: 'init',
                session_id: 'session-3',
                model: 'claude-opus-4-7[1m]'
            }
            converter.convert(initMsg)

            // First assistant gets the 1M estimate from the [1m] suffix
            const first = converter.convert(makeAssistantMessage()) as any
            expect(first?.message?.usage?.context_window).toBe(1_000_000)

            // Result message reports authoritative contextWindow (say, 500k)
            const resultMsg: SDKResultMessage = {
                type: 'result',
                subtype: 'success',
                num_turns: 1,
                total_cost_usd: 0,
                duration_ms: 1,
                duration_api_ms: 1,
                is_error: false,
                session_id: 'session-3',
                modelUsage: {
                    'claude-opus-4-7[1m]': { contextWindow: 500_000 }
                }
            }
            converter.convert(resultMsg)

            // Subsequent assistant message uses the refined value
            const second = converter.convert(makeAssistantMessage()) as any
            expect(second?.message?.usage?.context_window).toBe(500_000)
        })

        it('does not overwrite an explicit context_window already set by upstream', () => {
            const initMsg: SDKSystemMessage = {
                type: 'system',
                subtype: 'init',
                session_id: 'session-4',
                model: 'claude-opus-4-7[1m]'
            }
            converter.convert(initMsg)

            const assistantMsg: SDKAssistantMessage = {
                type: 'assistant',
                message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'hi' }],
                    usage: {
                        input_tokens: 10,
                        output_tokens: 20,
                        context_window: 42
                    }
                } as any
            }

            const log = converter.convert(assistantMsg) as any
            expect(log?.message?.usage?.context_window).toBe(42)
        })

        it('leaves usage untouched when no system.init was seen', () => {
            const log = converter.convert(makeAssistantMessage()) as any
            expect(log?.message?.usage?.context_window).toBeUndefined()
        })

        it('does not downgrade to the 200k heuristic on a same-model re-init after result refined it (sticky, per-model)', () => {
            // Turn 1: new-CLI-style init with no [1m] suffix (the actual regression trigger).
            converter.convert({
                type: 'system',
                subtype: 'init',
                session_id: 'session-5',
                model: 'claude-opus-4-8'
            } as SDKSystemMessage)

            const turn1 = converter.convert({
                type: 'assistant',
                message: {
                    role: 'assistant',
                    model: 'claude-opus-4-8',
                    content: [{ type: 'text', text: 'hi' }],
                    usage: { input_tokens: 10, output_tokens: 20 }
                }
            } as any) as any
            expect(turn1?.message?.usage?.context_window).toBe(200_000)

            // Result arrives with the authoritative window for this model.
            converter.convert({
                type: 'result',
                subtype: 'success',
                num_turns: 1,
                total_cost_usd: 0,
                duration_ms: 1,
                duration_api_ms: 1,
                is_error: false,
                session_id: 'session-5',
                modelUsage: {
                    'claude-opus-4-8': { contextWindow: 1_000_000 }
                }
            } as SDKResultMessage)

            // Turn 2: the CLI re-emits system/init for the *same* model (this happens on
            // every turn in the remote launcher's while-loop). The stale 200k heuristic
            // must NOT clobber the value we already learned from result.modelUsage.
            converter.convert({
                type: 'system',
                subtype: 'init',
                session_id: 'session-5',
                model: 'claude-opus-4-8'
            } as SDKSystemMessage)

            const turn2 = converter.convert({
                type: 'assistant',
                message: {
                    role: 'assistant',
                    model: 'claude-opus-4-8',
                    content: [{ type: 'text', text: 'hi again' }],
                    usage: { input_tokens: 10, output_tokens: 20 }
                }
            } as any) as any
            expect(turn2?.message?.usage?.context_window).toBe(1_000_000)
        })

        it('gives a switched-to model its own seed instead of inheriting the previous model\'s cached window (per-model cache, not globally sticky)', () => {
            // Learn opus's real 1M window first.
            converter.convert({
                type: 'system',
                subtype: 'init',
                session_id: 'session-6',
                model: 'claude-opus-4-8'
            } as SDKSystemMessage)
            converter.convert({
                type: 'result',
                subtype: 'success',
                num_turns: 1,
                total_cost_usd: 0,
                duration_ms: 1,
                duration_api_ms: 1,
                is_error: false,
                session_id: 'session-6',
                modelUsage: {
                    'claude-opus-4-8': { contextWindow: 1_000_000 }
                }
            } as SDKResultMessage)

            // User switches to a different model mid-session. It has no cached value and no
            // 1M seed signal here (bare init, no selectedModel), so it gets its own
            // conservative 200k seed rather than inheriting opus's cached 1M. (Its real
            // window would arrive with its own first result; this asserts cache isolation,
            // i.e. the value is keyed per model rather than a single global sticky number.)
            converter.convert({
                type: 'system',
                subtype: 'init',
                session_id: 'session-6',
                model: 'claude-sonnet-5'
            } as SDKSystemMessage)

            const afterSwitch = converter.convert({
                type: 'assistant',
                message: {
                    role: 'assistant',
                    model: 'claude-sonnet-5',
                    content: [{ type: 'text', text: 'hi' }],
                    usage: { input_tokens: 10, output_tokens: 20 }
                }
            } as any) as any

            // The switched-to model gets its own seed, not opus's cached 1M value.
            expect(afterSwitch?.message?.usage?.context_window).toBe(200_000)
        })

        it('seeds a 1M turn-1 estimate from selectedModel for an [1m] preset whose init model arrives bare (fable[1m] shape)', () => {
            // Real claude 2.1.200 shape for "fable[1m]": init.model and result keys are
            // BARE ("claude-fable-5", no suffix), unlike opus[1m]/sonnet[1m] which keep it.
            // So systemMsg.model.endsWith('[1m]') is false here — the selectedModel hint is
            // the only thing that lets turn 1 seed 1M instead of flashing 200k until the
            // first result lands. This is why the selectedModel seed is load-bearing.
            const seededConverter = new SDKToLogConverter({
                ...context,
                selectedModel: 'fable[1m]'
            } as any)

            seededConverter.convert({
                type: 'system',
                subtype: 'init',
                session_id: 'session-7',
                model: 'claude-fable-5'
            } as SDKSystemMessage)

            const turn1 = seededConverter.convert({
                type: 'assistant',
                message: {
                    role: 'assistant',
                    model: 'claude-fable-5',
                    content: [{ type: 'text', text: 'hi' }],
                    usage: { input_tokens: 10, output_tokens: 20 }
                }
            } as any) as any

            expect(turn1?.message?.usage?.context_window).toBe(1_000_000)
        })

        it('seeds a conservative 200k when neither the bare init model nor a selectedModel hint indicates 1M, until result confirms it', () => {
            // Bare init model + no selectedModel hint: neither signal says "1M", so we can't
            // know the real window on turn 1 and seed 200k conservatively rather than
            // guessing high. The authoritative value arrives with the first result. (A real
            // 1M account whose init keeps the suffix, e.g. "claude-opus-4-8[1m]", or that
            // carries a selectedModel hint, seeds 1M immediately instead — covered above.)
            const defaultConverter = new SDKToLogConverter({ ...context } as any)

            defaultConverter.convert({
                type: 'system',
                subtype: 'init',
                session_id: 'session-8',
                model: 'claude-fable-5'
            } as SDKSystemMessage)

            const turn1 = defaultConverter.convert({
                type: 'assistant',
                message: {
                    role: 'assistant',
                    model: 'claude-fable-5',
                    content: [{ type: 'text', text: 'hi' }],
                    usage: { input_tokens: 10, output_tokens: 20 }
                }
            } as any) as any

            expect(turn1?.message?.usage?.context_window).toBe(200_000)
        })

        it('seeds correctly after a live mid-session switch TO an [1m] preset (updateSelectedModel), not the stale construction-time value', () => {
            // Session started on Default (no selectedModel) -- as HAPI's remote launcher
            // does for every turn via updateSelectedModel(), not just turn 1.
            const liveConverter = new SDKToLogConverter({ ...context } as any)

            liveConverter.convert({
                type: 'system',
                subtype: 'init',
                session_id: 'session-9',
                model: 'claude-sonnet-5'
            } as SDKSystemMessage)
            const beforeSwitch = liveConverter.convert({
                type: 'assistant',
                message: {
                    role: 'assistant',
                    model: 'claude-sonnet-5',
                    content: [{ type: 'text', text: 'hi' }],
                    usage: { input_tokens: 10, output_tokens: 20 }
                }
            } as any) as any
            expect(beforeSwitch?.message?.usage?.context_window).toBe(200_000)

            // User switches to an explicit 1M preset (fable[1m], whose init model arrives
            // bare so the selectedModel hint is what carries the 1M signal). Without a live
            // update, the converter would still be seeding from the session-start snapshot
            // (none) and would under-seed 200k for this new model's first turn too.
            liveConverter.updateSelectedModel('fable[1m]')
            liveConverter.convert({
                type: 'system',
                subtype: 'init',
                session_id: 'session-9',
                model: 'claude-fable-5'
            } as SDKSystemMessage)
            const afterSwitch = liveConverter.convert({
                type: 'assistant',
                message: {
                    role: 'assistant',
                    model: 'claude-fable-5',
                    content: [{ type: 'text', text: 'hi' }],
                    usage: { input_tokens: 10, output_tokens: 20 }
                }
            } as any) as any
            expect(afterSwitch?.message?.usage?.context_window).toBe(1_000_000)
        })

        it('does not over-seed after a live mid-session switch AWAY FROM an [1m] preset (updateSelectedModel)', () => {
            // Session started on an explicit 1M preset (fable[1m]; its init model arrives
            // bare, so the selectedModel hint carries the 1M signal on turn 1).
            const liveConverter = new SDKToLogConverter({
                ...context,
                selectedModel: 'fable[1m]'
            } as any)

            liveConverter.convert({
                type: 'system',
                subtype: 'init',
                session_id: 'session-10',
                model: 'claude-fable-5'
            } as SDKSystemMessage)
            const beforeSwitch = liveConverter.convert({
                type: 'assistant',
                message: {
                    role: 'assistant',
                    model: 'claude-fable-5',
                    content: [{ type: 'text', text: 'hi' }],
                    usage: { input_tokens: 10, output_tokens: 20 }
                }
            } as any) as any
            expect(beforeSwitch?.message?.usage?.context_window).toBe(1_000_000)

            // User switches away to a model with no 1M signal (no "[1m]" on the updated
            // selectedModel and none on the bare init model). Without a live update, the
            // converter would still be seeding from the stale "fable[1m]" snapshot and
            // would over-seed 1,000,000 for the newly-selected model's first turn.
            liveConverter.updateSelectedModel('sonnet')
            liveConverter.convert({
                type: 'system',
                subtype: 'init',
                session_id: 'session-10',
                model: 'claude-sonnet-5'
            } as SDKSystemMessage)
            const afterSwitch = liveConverter.convert({
                type: 'assistant',
                message: {
                    role: 'assistant',
                    model: 'claude-sonnet-5',
                    content: [{ type: 'text', text: 'hi' }],
                    usage: { input_tokens: 10, output_tokens: 20 }
                }
            } as any) as any
            expect(afterSwitch?.message?.usage?.context_window).toBe(200_000)
        })

        it('injects 1M for an explicit [1m] preset whose assistant messages report a bare model id (real opus[1m] shape)', () => {
            // Real claude 2.1.200 shape for an explicit "opus[1m]" session: system/init and
            // result.modelUsage both use the suffixed id "claude-opus-4-8[1m]", while each
            // assistant message reports the bare "claude-opus-4-8". Because init and result
            // agree, the cache stores 1M under the suffixed key and the assistant lookup —
            // which goes through the resolved cache key (= the suffixed init id here), not
            // the bare message.model — finds it. (A lookup keyed on the bare message.model
            // would miss.)
            const seededConverter = new SDKToLogConverter({
                ...context,
                selectedModel: 'opus[1m]'
            } as any)

            seededConverter.convert({
                type: 'system',
                subtype: 'init',
                session_id: 'session-11',
                model: 'claude-opus-4-8[1m]'
            } as SDKSystemMessage)

            // result reports the authoritative 1M under the SUFFIXED key...
            seededConverter.convert({
                type: 'result',
                subtype: 'success',
                num_turns: 1,
                total_cost_usd: 0,
                duration_ms: 1,
                duration_api_ms: 1,
                is_error: false,
                session_id: 'session-11',
                modelUsage: {
                    'claude-opus-4-8[1m]': { contextWindow: 1_000_000 }
                }
            } as SDKResultMessage)

            // ...but the assistant message reports the BARE model id.
            const assistant = seededConverter.convert({
                type: 'assistant',
                message: {
                    role: 'assistant',
                    model: 'claude-opus-4-8',
                    content: [{ type: 'text', text: 'hi' }],
                    usage: { input_tokens: 10, output_tokens: 20 }
                }
            } as any) as any

            expect(assistant?.message?.usage?.context_window).toBe(1_000_000)
        })

        it('injects the MAIN session window into a sidechain (subagent) message, not the subagent model\'s own window', () => {
            // Main session is opus[1m] (1M). A Task subagent runs on haiku (200k). Because
            // the web status bar picks the most recent usage message without filtering
            // sidechains, the subagent's assistant message must carry the main 1M window,
            // or the footer denominator would visibly drop to 200k while the subagent runs.
            // The subagent emits no system/init of its own, so the resolved cache key stays
            // on the main model — and since lookups always go through that key, the sidechain
            // message inherits the main window automatically. (The subagent's own 200k is
            // still cached under its own id, but it is never the resolved lookup key here.)
            const liveConverter = new SDKToLogConverter({
                ...context,
                selectedModel: 'opus[1m]'
            } as any)

            liveConverter.convert({
                type: 'system',
                subtype: 'init',
                session_id: 'session-12',
                model: 'claude-opus-4-8[1m]'
            } as SDKSystemMessage)
            liveConverter.convert({
                type: 'result',
                subtype: 'success',
                num_turns: 1,
                total_cost_usd: 0,
                duration_ms: 1,
                duration_api_ms: 1,
                is_error: false,
                session_id: 'session-12',
                modelUsage: {
                    'claude-opus-4-8[1m]': { contextWindow: 1_000_000 },
                    'claude-haiku-4-5-20251001': { contextWindow: 200_000 }
                }
            } as SDKResultMessage)

            // Sidechain assistant message from the haiku subagent (carries parent_tool_use_id).
            const sidechain = liveConverter.convert({
                type: 'assistant',
                parent_tool_use_id: 'toolu_task_1',
                message: {
                    role: 'assistant',
                    model: 'claude-haiku-4-5-20251001',
                    content: [{ type: 'text', text: 'subagent reply' }],
                    usage: { input_tokens: 10, output_tokens: 20 }
                }
            } as any) as any

            expect(sidechain?.message?.usage?.context_window).toBe(1_000_000)
        })

        it('keeps plain vs [1m] variants of the same base model on distinct cache keys (multi-tier: no collision)', () => {
            // On some tiers plain "sonnet" is 200k while "sonnet[1m]" is 1M. For sonnet the
            // CLI already reports the "[1m]" on system/init.model and the result key, so the
            // two variants land on DISTINCT cache keys on their own (only the per-turn
            // assistant message.model is bare/lossy, which is why lookups go through the
            // resolved cache key, not message.model). fable is the case where the CLI does
            // NOT suffix the id and the key has to be folded — covered by the next test.
            const conv = new SDKToLogConverter({ ...context, selectedModel: 'sonnet[1m]' } as any)

            // Turn 1 on sonnet[1m]: learns 1M under the suffixed key.
            conv.convert({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-sonnet-5[1m]' } as SDKSystemMessage)
            conv.convert({
                type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0,
                duration_ms: 1, duration_api_ms: 1, is_error: false, session_id: 's',
                modelUsage: { 'claude-sonnet-5[1m]': { contextWindow: 1_000_000 } }
            } as SDKResultMessage)
            const t1 = conv.convert({
                type: 'assistant',
                message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'a' }], usage: { input_tokens: 10, output_tokens: 20 } }
            } as any) as any
            expect(t1?.message?.usage?.context_window).toBe(1_000_000)

            // Switch to plain sonnet (200k on this tier): learns 200k under the bare key.
            conv.updateSelectedModel('sonnet')
            conv.convert({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-sonnet-5' } as SDKSystemMessage)
            conv.convert({
                type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0,
                duration_ms: 1, duration_api_ms: 1, is_error: false, session_id: 's',
                modelUsage: { 'claude-sonnet-5': { contextWindow: 200_000 } }
            } as SDKResultMessage)
            const t2 = conv.convert({
                type: 'assistant',
                message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'b' }], usage: { input_tokens: 10, output_tokens: 20 } }
            } as any) as any
            expect(t2?.message?.usage?.context_window).toBe(200_000)

            // Switch back to sonnet[1m], turn-1 before its result re-arrives: must still read
            // 1M from the suffixed key, NOT the 200k that plain sonnet just cached under the
            // bare key (that cross-contamination is exactly what suffix-stripping would cause).
            conv.updateSelectedModel('sonnet[1m]')
            conv.convert({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-sonnet-5[1m]' } as SDKSystemMessage)
            const t3 = conv.convert({
                type: 'assistant',
                message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'c' }], usage: { input_tokens: 10, output_tokens: 20 } }
            } as any) as any
            expect(t3?.message?.usage?.context_window).toBe(1_000_000)
        })

        it('distinguishes fable vs fable[1m] even though the CLI reports both with the bare id', () => {
            // Unlike opus[1m]/sonnet[1m], the CLI reports BOTH "fable" and "fable[1m]" with
            // the bare id "claude-fable-5" on system/init and in result.modelUsage. A cache
            // keyed on that raw id alone can't tell the two apart, so switching fable[1m]
            // (1M) -> fable (200k) would keep showing the stale 1M until fable's result
            // lands. Folding the selectedModel's "[1m]" into the cache key keeps them
            // distinct. selectedModel is the ONLY turn-1 signal that separates them here.
            const conv = new SDKToLogConverter({ ...context, selectedModel: 'fable[1m]' } as any)

            // fable[1m]: seeds 1M from selectedModel, result confirms 1M.
            conv.convert({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-fable-5' } as SDKSystemMessage)
            conv.convert({
                type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0,
                duration_ms: 1, duration_api_ms: 1, is_error: false, session_id: 's',
                modelUsage: { 'claude-fable-5': { contextWindow: 1_000_000 } }
            } as SDKResultMessage)
            const t1 = conv.convert({
                type: 'assistant',
                message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: 'a' }], usage: { input_tokens: 10, output_tokens: 20 } }
            } as any) as any
            expect(t1?.message?.usage?.context_window).toBe(1_000_000)

            // Switch to plain fable (200k): must re-seed 200k, NOT keep the stale 1M.
            conv.updateSelectedModel('fable')
            conv.convert({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-fable-5' } as SDKSystemMessage)
            const t2 = conv.convert({
                type: 'assistant',
                message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: 'b' }], usage: { input_tokens: 10, output_tokens: 20 } }
            } as any) as any
            expect(t2?.message?.usage?.context_window).toBe(200_000)

            // Switch back to fable[1m]: its 1M entry was never overwritten by plain fable's
            // 200k (distinct keys), so turn-1 before the next result still reads 1M.
            conv.updateSelectedModel('fable[1m]')
            conv.convert({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-fable-5' } as SDKSystemMessage)
            const t3 = conv.convert({
                type: 'assistant',
                message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: 'c' }], usage: { input_tokens: 10, output_tokens: 20 } }
            } as any) as any
            expect(t3?.message?.usage?.context_window).toBe(1_000_000)
        })
    })

    describe('Parent-child relationships', () => {
        it('should track parent UUIDs across messages', () => {
            const msg1: SDKUserMessage = {
                type: 'user',
                message: { role: 'user', content: 'First' }
            }
            const msg2: SDKAssistantMessage = {
                type: 'assistant',
                message: { role: 'assistant', content: [{ type: 'text', text: 'Second' }] }
            }
            const msg3: SDKUserMessage = {
                type: 'user',
                message: { role: 'user', content: 'Third' }
            }

            const log1 = converter.convert(msg1)
            const log2 = converter.convert(msg2)
            const log3 = converter.convert(msg3)

            expect(log1?.parentUuid).toBeNull()
            expect(log2?.parentUuid).toBe(log1?.uuid)
            expect(log3?.parentUuid).toBe(log2?.uuid)
        })

        it('should reset parent chain when requested', () => {
            const msg1: SDKUserMessage = {
                type: 'user',
                message: { role: 'user', content: 'First' }
            }
            const log1 = converter.convert(msg1)

            converter.resetParentChain()

            const msg2: SDKUserMessage = {
                type: 'user',
                message: { role: 'user', content: 'Second' }
            }
            const log2 = converter.convert(msg2)

            expect(log2?.parentUuid).toBeNull()
        })
    })

    describe('Batch conversion', () => {
        it('should convert multiple messages maintaining relationships', () => {
            const messages: SDKMessage[] = [
                {
                    type: 'user',
                    message: { role: 'user', content: 'Hello' }
                } as SDKUserMessage,
                {
                    type: 'assistant',
                    message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] }
                } as SDKAssistantMessage,
                {
                    type: 'user',
                    message: { role: 'user', content: 'How are you?' }
                } as SDKUserMessage
            ]

            const logMessages = converter.convertMany(messages)

            expect(logMessages).toHaveLength(3)
            expect(logMessages[0].parentUuid).toBeNull()
            expect(logMessages[1].parentUuid).toBe(logMessages[0].uuid)
            expect(logMessages[2].parentUuid).toBe(logMessages[1].uuid)
        })
    })

    describe('Internal event filtering', () => {
        it('should suppress rate_limit_event with allowed status', () => {
            const sdkMessage = {
                type: 'rate_limit_event',
                rate_limit_info: {
                    status: 'allowed',
                    resetsAt: 1775559600,
                    rateLimitType: 'five_hour'
                }
            } as unknown as SDKMessage

            expect(converter.convert(sdkMessage)).toBeNull()
        })

        it('should convert allowed_warning to pipe-delimited text', () => {
            const sdkMessage = {
                type: 'rate_limit_event',
                rate_limit_info: {
                    status: 'allowed_warning',
                    resetsAt: 1775559600,
                    utilization: 0.85,
                    rateLimitType: 'five_hour'
                }
            } as unknown as SDKMessage

            const logMessage = converter.convert(sdkMessage)

            expect(logMessage).not.toBeNull()
            expect(logMessage!.type).toBe('assistant')
            expect((logMessage as any).message.content[0].text).toBe(
                'Claude AI usage limit warning|1775559600|85|five_hour'
            )
        })

        it('should convert rejected to pipe-delimited text', () => {
            const sdkMessage = {
                type: 'rate_limit_event',
                rate_limit_info: {
                    status: 'rejected',
                    resetsAt: 1775559600,
                    rateLimitType: 'five_hour'
                }
            } as unknown as SDKMessage

            const logMessage = converter.convert(sdkMessage)

            expect(logMessage).not.toBeNull()
            expect(logMessage!.type).toBe('assistant')
            expect((logMessage as any).message.content[0].text).toBe(
                'Claude AI usage limit reached|1775559600|five_hour'
            )
        })

        it('should not break parent chain when rate_limit_event is suppressed', () => {
            const user = converter.convert({
                type: 'user',
                message: { role: 'user', content: 'hi' }
            } as SDKUserMessage)

            converter.convert({
                type: 'rate_limit_event',
                rate_limit_info: { status: 'allowed' }
            } as unknown as SDKMessage)

            const assistant = converter.convert({
                type: 'assistant',
                message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }
            } as SDKAssistantMessage)

            expect(assistant!.parentUuid).toBe(user!.uuid)
        })

        it('should chain parent correctly when rate_limit_event is converted', () => {
            const user = converter.convert({
                type: 'user',
                message: { role: 'user', content: 'hi' }
            } as SDKUserMessage)

            const warning = converter.convert({
                type: 'rate_limit_event',
                rate_limit_info: {
                    status: 'allowed_warning',
                    resetsAt: 1775559600,
                    utilization: 0.8,
                    rateLimitType: 'five_hour'
                }
            } as unknown as SDKMessage)

            const assistant = converter.convert({
                type: 'assistant',
                message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }
            } as SDKAssistantMessage)

            expect(warning!.parentUuid).toBe(user!.uuid)
            expect(assistant!.parentUuid).toBe(warning!.uuid)
        })
    })

    describe('Convenience function', () => {
        it('should convert single message without state', () => {
            const sdkMessage: SDKUserMessage = {
                type: 'user',
                message: { role: 'user', content: 'Test message' }
            }

            const logMessage = convertSDKToLog(sdkMessage, context)

            expect(logMessage).toBeTruthy()
            expect(logMessage?.type).toBe('user')
            expect(logMessage?.parentUuid).toBeNull()
        })
    })

    describe('Tool results with mode', () => {
        it('should add mode to tool result when available in responses', () => {
            const responses = new Map<string, { approved: boolean; mode?: ClaudePermissionMode; reason?: string }>()
            responses.set('tool_123', { approved: true, mode: 'acceptEdits' })
            
            const converterWithResponses = new SDKToLogConverter(context, responses)
            
            const sdkMessage: SDKUserMessage = {
                type: 'user',
                message: {
                    role: 'user',
                    content: [{
                        type: 'tool_result',
                        tool_use_id: 'tool_123',
                        content: 'Tool executed successfully'
                    }]
                }
            }

            const logMessage = converterWithResponses.convert(sdkMessage)

            expect(logMessage).toBeTruthy()
            expect((logMessage as any).mode).toBe('acceptEdits')
            expect((logMessage as any).toolUseResult).toBeUndefined() // toolUseResult is not added when using array content
        })

        it('should not add mode when not in responses', () => {
            const responses = new Map<string, { approved: boolean; mode?: ClaudePermissionMode; reason?: string }>()
            
            const converterWithResponses = new SDKToLogConverter(context, responses)
            
            const sdkMessage: SDKUserMessage = {
                type: 'user',
                message: {
                    role: 'user',
                    content: [{
                        type: 'tool_result',
                        tool_use_id: 'tool_456',
                        content: 'Tool result'
                    }]
                }
            }

            const logMessage = converterWithResponses.convert(sdkMessage)

            expect(logMessage).toBeTruthy()
            expect((logMessage as any).mode).toBeUndefined()
            expect((logMessage as any).toolUseResult).toBeUndefined() // toolUseResult is not added when using array content
        })

        it('should handle mixed content with tool results', () => {
            const responses = new Map<string, { approved: boolean; mode?: ClaudePermissionMode; reason?: string }>()
            responses.set('tool_789', { approved: true, mode: 'bypassPermissions' })
            
            const converterWithResponses = new SDKToLogConverter(context, responses)
            
            const sdkMessage: SDKUserMessage = {
                type: 'user',
                message: {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Here is the result:' },
                        {
                            type: 'tool_result',
                            tool_use_id: 'tool_789',
                            content: 'Tool output'
                        }
                    ]
                }
            }

            const logMessage = converterWithResponses.convert(sdkMessage)

            expect(logMessage).toBeTruthy()
            expect((logMessage as any).mode).toBe('bypassPermissions')
            expect((logMessage as any).toolUseResult).toBeUndefined() // toolUseResult is not added when using array content
        })

        it('should work with convenience function', () => {
            const responses = new Map<string, { approved: boolean; mode?: ClaudePermissionMode; reason?: string }>()
            responses.set('tool_abc', { approved: false, mode: 'plan', reason: 'User rejected' })
            
            const sdkMessage: SDKUserMessage = {
                type: 'user',
                message: {
                    role: 'user',
                    content: [{
                        type: 'tool_result',
                        tool_use_id: 'tool_abc',
                        content: 'Permission denied'
                    }]
                }
            }

            const logMessage = convertSDKToLog(sdkMessage, context, responses)

            expect(logMessage).toBeTruthy()
            expect((logMessage as any).mode).toBe('plan')
        })
    })
})
