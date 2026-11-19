import { describe, expect, it } from 'bun:test'
import { toSessionSummary, type SyncEvent } from '@hapi/protocol'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

const userText = (text: string) => ({ role: 'user', content: { type: 'text', text } })

describe('session parent link recording and persistence', () => {
    function setup() {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast: (event: SyncEvent) => events.push(event) } as never
        )
        const receive = (sessionId: string, content: unknown, localId?: string) => {
            const message = store.messages.addMessage(sessionId, content, localId)
            engine.handleRealtimeEvent({ type: 'message-received', sessionId, message })
        }
        return { store, events, engine, receive }
    }

    it('records parentSessionId from an explicit ## Parent remit in the same namespace', () => {
        const { store, events, engine, receive } = setup()
        try {
            const parent = engine.getOrCreateSession('parent-tag', { path: '/tmp/repo', host: 'mac' }, null, 'default')
            const child = engine.getOrCreateSession('child-tag', { path: '/tmp/repo', host: 'mac' }, null, 'default')

            const remit = [
                '## Parent',
                `- Orchestrator chip (mandatory): [Lead](/sessions/${parent.id})`,
                '',
                'Verify the build'
            ].join('\n')
            receive(child.id, userText(remit), 'remit-1')

            const updated = engine.getSession(child.id)!
            expect(updated.metadata?.parentSessionId).toBe(parent.id)
            const summary = toSessionSummary(updated)
            expect(summary.metadata?.parentLink).toEqual({
                parentSessionId: parent.id,
                kind: 'peer'
            })

            const patch = events.find((event) => event.type === 'session-updated'
                && event.sessionId === child.id
                && (event.data as { metadata?: { value?: { parentSessionId?: string } } } | undefined)?.metadata?.value?.parentSessionId === parent.id)
            expect(patch).toBeDefined()
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('ignores same-namespace citations without a canonical parent stamp', () => {
        const { store, engine, receive } = setup()
        try {
            const metadata = { path: '/tmp/repo', host: 'mac' }
            const parent = engine.getOrCreateSession('parent', metadata, null, 'default')
            const child = engine.getOrCreateSession('child', metadata, null, 'default')
            const chip = `[Lead](/sessions/${parent.id})`
            for (const prompt of [
                `## Parent branch notes\n- Orchestrator chip (mandatory): ${chip}`,
                `## Parent\nSee ${chip} for context`,
            ]) {
                receive(child.id, userText(prompt))
                expect(engine.getSession(child.id)?.metadata?.parentSessionId).toBeUndefined()
            }
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('ignores casual /sessions/<id> citations, unknown targets, and cross-namespace parents', () => {
        const { store, engine, receive } = setup()
        try {
            const otherNsParent = engine.getOrCreateSession('other-ns-parent', { path: '/tmp/repo', host: 'mac' }, null, 'other-ns')
            const sameNsChild = engine.getOrCreateSession('child-tag', { path: '/tmp/repo', host: 'mac' }, null, 'default')

            receive(sameNsChild.id, userText(`See session "Other" (/sessions/${otherNsParent.id}) for context`), 'casual')
            expect(engine.getSession(sameNsChild.id)?.metadata?.parentSessionId).toBeUndefined()

            const crossNsRemit = [
                '## Parent',
                `- Orchestrator chip (mandatory): [Foreign](/sessions/${otherNsParent.id})`,
                '',
                'Do work'
            ].join('\n')
            receive(sameNsChild.id, userText(crossNsRemit), 'cross-ns')
            expect(engine.getSession(sameNsChild.id)?.metadata?.parentSessionId).toBeUndefined()

            const selfRemit = [
                '## Parent',
                `- Orchestrator chip (mandatory): [Self](/sessions/${sameNsChild.id})`,
                '',
                'Loop check'
            ].join('\n')
            receive(sameNsChild.id, userText(selfRemit), 'self')
            expect(engine.getSession(sameNsChild.id)?.metadata?.parentSessionId).toBeUndefined()
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('adopts a preallocated peer with its updated parent after a parent merge', async () => {
        const { store, engine } = setup()
        try {
            const metadata = { path: '/tmp/repo', host: 'mac' }
            const parent = engine.getOrCreateSession('parent', metadata, null, 'default')
            const replacement = engine.getOrCreateSession('replacement', metadata, null, 'default')
            const peerId = crypto.randomUUID()
            engine.getOrCreateSession(
                `machine-spawn:${peerId}`, { ...metadata, parentSessionId: parent.id },
                null, 'default', undefined, undefined, undefined, peerId
            )

            await engine['sessionCache'].mergeSessions(parent.id, replacement.id, 'default')
            const adopted = engine.adoptPreallocatedSession(peerId, 'runner-peer', metadata, null, 'default')
            expect(adopted.id).toBe(peerId)
            expect(adopted.metadata?.parentSessionId).toBe(replacement.id)
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('preserves hub-owned parentSessionId across sparse CLI metadata rewrites', () => {
        const { store, engine } = setup()
        try {
            const parent = engine.getOrCreateSession('parent-tag', { path: '/tmp/repo', host: 'mac' }, null, 'default')
            const child = engine.getOrCreateSession(
                'child-tag',
                { path: '/tmp/repo', host: 'mac', parentSessionId: parent.id },
                null,
                'default'
            )

            const update = store.sessions.updateSessionMetadata(
                child.id,
                { path: '/tmp/repo', host: 'mac' },
                child.metadataVersion,
                'default'
            )
            expect(update.result).toBe('success')
            expect(store.sessions.getSession(child.id)?.metadata).toMatchObject({
                parentSessionId: parent.id
            })
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('sanitizes incoming parentSessionId on session creation across namespaces', () => {
        const { store, engine } = setup()
        try {
            const otherNsParent = engine.getOrCreateSession('foreign-parent', { path: '/tmp/repo', host: 'mac' }, null, 'other-ns')
            const sameNsParent = engine.getOrCreateSession('same-parent', { path: '/tmp/repo', host: 'mac' }, null, 'default')

            const rejected = engine.getOrCreateSession(
                'rejected-child',
                { path: '/tmp/repo', host: 'mac', parentSessionId: otherNsParent.id },
                null,
                'default'
            )
            expect(rejected.metadata?.parentSessionId).toBeUndefined()

            const accepted = engine.getOrCreateSession(
                'accepted-child',
                { path: '/tmp/repo', host: 'mac', parentSessionId: sameNsParent.id },
                null,
                'default'
            )
            expect(accepted.metadata?.parentSessionId).toBe(sameNsParent.id)
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('correlates codeagent-wrapper SESSION_ID outputs with native sessions in the same namespace', () => {
        const { store, engine, receive } = setup()
        try {
            const parent = engine.getOrCreateSession('lead', { path: '/tmp/repo', host: 'mac' }, null, 'default')
            const existingCodex = engine.getOrCreateSession(
                'existing-codex',
                { path: '/tmp/repo', host: 'mac', flavor: 'codex', codexSessionId: '019a0000-1111-7222-8333-444455556666' },
                null,
                'default'
            )
            const foreignCodex = engine.getOrCreateSession(
                'foreign-codex',
                { path: '/tmp/repo', host: 'mac', flavor: 'codex', codexSessionId: '019a0000-1111-7222-8333-444455556666' },
                null,
                'other-ns'
            )

            receive(parent.id, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            role: 'assistant',
                            content: [{
                                type: 'tool_use',
                                id: 'toolu_wrap_1',
                                name: 'Bash',
                                input: { command: 'codeagent-wrapper --backend codex - "/tmp/repo"' },
                            }]
                        }
                    }
                }
            }, 'wrapper-tool-use-1')

            receive(parent.id, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'user',
                        message: {
                            content: [{
                                type: 'tool_result',
                                tool_use_id: 'toolu_wrap_1',
                                content: [
                                    'Backend check finished',
                                    '---',
                                    'SESSION_ID: 019a0000-1111-7222-8333-444455556666',
                                    '---',
                                    'SESSION_ID: agy-follow-up-99',
                                ].join('\n')
                            }]
                        }
                    }
                }
            }, 'wrapper-tool-res-1')

            expect(engine.getSession(existingCodex.id)?.metadata?.parentSessionId).toBe(parent.id)
            expect(engine.getSession(foreignCodex.id)?.metadata?.parentSessionId).toBeUndefined()

            const laterImportedAgy = engine.getOrCreateSession(
                'later-agy',
                { path: '/tmp/repo', host: 'mac', flavor: 'agy', agySessionId: 'agy-follow-up-99' },
                null,
                'default'
            )
            expect(engine.getSession(laterImportedAgy.id)?.metadata?.parentSessionId).toBe(parent.id)
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('links both workers from a command with two wrapper backends', () => {
        const { store, engine, receive } = setup()
        try {
            const metadata = { path: '/r', host: 'mac', machineId: 'machine-1' }
            const parent = engine.getOrCreateSession('lead', metadata, null, 'default')
            const workers = ['codex', 'claude'].map(flavor => engine.getOrCreateSession(
                flavor, { ...metadata, flavor, [`${flavor}SessionId`]: `${flavor}-worker` }, null, 'default'
            ))
            receive(parent.id, {
                role: 'agent', content: { type: 'output', data: {
                    type: 'agy_tool_action',
                    input: { command: 'codeagent-wrapper --backend codex - /r & codeagent-wrapper --backend claude - /r; wait' },
                    content: '---\nSESSION_ID: codex-worker\n---\nSESSION_ID: claude-worker',
                } },
            })
            for (const worker of workers) expect(engine.getSession(worker.id)?.metadata?.parentSessionId).toBe(parent.id)
        } finally {
            engine.stop()
            store.close()
        }
    })

    it.each([false, true])('links an attached Codex worker unless an owned row exists (owned: %s)', (hasOwned) => {
        const { store, engine, receive } = setup()
        try {
            const metadata = { path: '/r', host: 'mac', machineId: 'machine-1' }
            const parent = engine.getOrCreateSession('lead', metadata, null, 'default')
            const worker = { ...metadata, flavor: 'codex', codexSessionId: 'codex-worker' }
            const attached = engine.getOrCreateSession('attached', {
                ...worker, codexRuntime: { kind: 'attached', state: 'attached', bindingId: crypto.randomUUID() },
            }, null, 'default')
            const owned = hasOwned ? engine.getOrCreateSession('owned', worker, null, 'default') : null
            receive(parent.id, {
                role: 'agent', content: { type: 'output', data: {
                    type: 'agy_tool_action', input: { command: 'codeagent-wrapper --backend codex - /r' },
                    content: '---\nSESSION_ID: codex-worker',
                } },
            })
            expect(engine.getSession(attached.id)?.metadata?.parentSessionId).toBe(owned ? undefined : parent.id)
            if (owned) expect(engine.getSession(owned.id)?.metadata?.parentSessionId).toBe(parent.id)
        } finally {
            engine.stop()
            store.close()
        }
    })

    it.each(['opencode', 'pi'])('scopes immediate and late %s wrapper results to a single worker', (flavor) => {
        const { store, engine, receive } = setup()
        try {
            const metadata = { path: '/tmp/repo', host: 'mac', machineId: 'machine-1' }
            const parent = engine.getOrCreateSession('lead', metadata, null, 'default')
            const worker = (tag: string, machineId: string, nativeId: string) => engine.getOrCreateSession(
                tag, { ...metadata, machineId, flavor, [`${flavor}SessionId`]: nativeId }, null, 'default'
            )
            const local = worker('local', 'machine-1', 'immediate-id')
            const remote = worker('remote', 'machine-2', 'immediate-id')
            const duplicateA = worker('dup-a', 'machine-1', 'duplicate-id')
            const duplicateB = worker('dup-b', 'machine-1', 'duplicate-id')
            receive(parent.id, {
                role: 'agent', content: { type: 'codex', data: {
                    type: 'tool-call', callId: 'call', input: { command: `codeagent-wrapper --backend ${flavor} -` },
                } },
            })
            receive(parent.id, {
                role: 'agent', content: { type: 'codex', data: {
                    type: 'tool-call-result', callId: 'call',
                    output: ['immediate-id', 'late-native-id', 'duplicate-id'].map(id => `---\nSESSION_ID: ${id}`).join('\n'),
                } },
            })
            const lateRemote = worker('late-remote', 'machine-2', 'late-native-id')
            const lateLocal = worker('late-local', 'machine-1', 'late-native-id')
            for (const child of [local, lateLocal]) {
                expect(engine.getSession(child.id)?.metadata?.parentSessionId).toBe(parent.id)
            }
            for (const child of [remote, lateRemote, duplicateA, duplicateB]) {
                expect(engine.getSession(child.id)?.metadata?.parentSessionId).toBeUndefined()
            }
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('ignores SESSION_ID footers from non-wrapper tools such as reading logs', () => {
        const { store, engine, receive } = setup()
        try {
            const reader = engine.getOrCreateSession('reader', { path: '/tmp/repo', host: 'mac' }, null, 'default')
            const unrelated = engine.getOrCreateSession(
                'unrelated-codex',
                { path: '/tmp/repo', host: 'mac', flavor: 'codex', codexSessionId: '019a9999-1111-7222-8333-444455556666' },
                null,
                'default'
            )

            receive(reader.id, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            role: 'assistant',
                            content: [{
                                type: 'tool_use',
                                id: 'toolu_cat_log',
                                name: 'Bash',
                                input: { command: 'cat /tmp/saved-wrapper.log' },
                            }]
                        }
                    }
                }
            }, 'non-wrapper-use')

            receive(reader.id, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'user',
                        message: {
                            content: [{
                                type: 'tool_result',
                                tool_use_id: 'toolu_cat_log',
                                content: [
                                    'Saved log line',
                                    '---',
                                    'SESSION_ID: 019a9999-1111-7222-8333-444455556666',
                                ].join('\n')
                            }]
                        }
                    }
                }
            }, 'non-wrapper-result')

            expect(engine.getSession(unrelated.id)?.metadata?.parentSessionId).toBeUndefined()

            receive(reader.id, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            role: 'assistant',
                            content: [{
                                type: 'tool_use',
                                id: 'toolu_rg_log',
                                name: 'Bash',
                                input: { command: `rg -A 2 -- 'codeagent-wrapper --backend codex' wrapper.log` },
                            }]
                        }
                    }
                }
            }, 'search-pattern-use')

            receive(reader.id, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'user',
                        message: {
                            content: [{
                                type: 'tool_result',
                                tool_use_id: 'toolu_rg_log',
                                content: [
                                    'wrapper.log:12:codeagent-wrapper --backend codex',
                                    '---',
                                    'SESSION_ID: 019a9999-1111-7222-8333-444455556666',
                                ].join('\n')
                            }]
                        }
                    }
                }
            }, 'search-pattern-result')

            expect(engine.getSession(unrelated.id)?.metadata?.parentSessionId).toBeUndefined()
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('preserves argv boundaries for shell-wrapped Codex arrays and retargets children on parent merge', async () => {
        const { store, events, engine, receive } = setup()
        try {
            const oldParent = engine.getOrCreateSession('old-parent', { path: '/tmp/repo', host: 'mac' }, null, 'default')
            const newParent = engine.getOrCreateSession('new-parent', { path: '/tmp/repo', host: 'mac' }, null, 'default')
            const codexWorker = engine.getOrCreateSession(
                'codex-arr-child',
                { path: '/tmp/repo', host: 'mac', flavor: 'codex', codexSessionId: '019b1111-1111-7222-8333-444455556666' },
                null,
                'default'
            )

            receive(oldParent.id, {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'tool-call',
                        callId: 'call-arr-1',
                        name: 'exec_command',
                        input: { command: ['bash', '-lc', 'codeagent-wrapper --backend codex - "/tmp/repo"'] },
                    }
                }
            }, 'codex-arr-call')

            receive(oldParent.id, {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'tool-call-result',
                        callId: 'call-arr-1',
                        output: 'Finished\n---\nSESSION_ID: 019b1111-1111-7222-8333-444455556666',
                    }
                }
            }, 'codex-arr-result')

            expect(engine.getSession(codexWorker.id)?.metadata?.parentSessionId).toBe(oldParent.id)

            const forkedChild = engine.getOrCreateSession(
                'forked-child',
                { path: '/tmp/repo', host: 'mac', forkedFrom: oldParent.id },
                null,
                'default'
            )
            const branchedChild = engine.getOrCreateSession(
                'branched-child',
                {
                    path: '/tmp/repo',
                    host: 'mac',
                    conversationBranch: {
                        sourceSessionId: oldParent.id,
                        boundary: 'after',
                        mode: 'visible-text',
                        requestFingerprint: 'fp-merge-1',
                        state: 'started',
                        createdAt: 100,
                        messageCount: 1,
                        workspace: 'current',
                    }
                },
                null,
                'default'
            )

            const cache = (engine as unknown as {
                sessionCache: { mergeSessions: (a: string, b: string, ns: string) => Promise<void> }
            }).sessionCache
            await cache.mergeSessions(oldParent.id, newParent.id, 'default')

            expect(engine.getSession(codexWorker.id)?.metadata?.parentSessionId).toBe(newParent.id)
            expect(engine.getSession(forkedChild.id)?.metadata?.forkedFrom).toBe(newParent.id)
            expect(engine.getSession(branchedChild.id)?.metadata?.conversationBranch?.sourceSessionId).toBe(newParent.id)

            const lateChild = engine.getOrCreateSession(
                'late-child',
                { path: '/tmp/repo', host: 'mac', parentSessionId: oldParent.id },
                null,
                'default'
            )
            expect(engine.getSession(lateChild.id)?.metadata?.parentSessionId).toBe(newParent.id)
            expect(events.some((e) => e.type === 'session-updated' && e.sessionId === codexWorker.id)).toBe(true)
        } finally {
            engine.stop()
            store.close()
        }
    })
})
