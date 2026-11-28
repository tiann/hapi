import { expect, it } from 'bun:test'
import { SharedCodexProjection } from '../../cli/src/codex/shared/projection'
import { SharedCodexAsyncQuestions, asyncQuestionsForItem } from '../../cli/src/codex/shared/asyncQuestions'
import { Store } from '../src/store'
import { RpcRegistry } from '../src/socket/rpcRegistry'
import { SyncEngine } from '../src/sync/syncEngine'

it('removes a replayed async answer result with its answer turn from the Hub store', async () => {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    try {
        const session = engine.getOrCreateSession('codex-async-rewind', {
            path: '/tmp/project', host: 'test', flavor: 'codex',
            capabilities: { concurrentClients: true, conversationHistory: { rewindToMessage: true } },
        }, null, 'default')
        engine.handleSessionAlive({ sid: session.id, time: Date.now(), mode: 'remote' })
        const question = { id: 'async-question', type: 'agentMessage', delivery: 'async', text: 'Which client?',
            questions: [{ title: 'Which client?', options: ['Web', 'Terminal'] }] }
        const q = asyncQuestionsForItem('native', question)[0]!
        const insert = (id: string, content: unknown) => {
            store.messages.addMessage(session.id, content, id)
            store.messages.markMessagesInvoked(session.id, [id], Date.now())
        }
        const projected = {
            getMetadata: () => ({ codexSessionId: 'native' }),
            updateAgentState() {}, updateMetadata() {},
            sendUserMessage: (text: string, _metadata: unknown, id: string) => insert(id, { role: 'user', content: { type: 'text', text } }),
            sendAgentMessage: (body: unknown, id: string) => insert(id, { role: 'agent', content: { type: 'output', data: body } }),
        } as unknown as ConstructorParameters<typeof SharedCodexProjection>[0]
        const questions = new SharedCodexAsyncQuestions(projected, async () => {}, undefined)
        const projection = new SharedCodexProjection(projected, 'native', async () => {}, undefined, undefined,
            (threadId, item) => questions.observeItem(threadId, item))
        const questionTurn = { id: 'question-turn', status: 'completed', items: [question] }
        await projection.history({ turns: [questionTurn] })
        const nativeAnswer = { type: 'userMessage', id: 'answer-native-id', clientId: 'answer-remote', content: [
            { type: 'text', text: `<send_user_message_question_reply>\n${JSON.stringify([{
                questionItemId: q.questionItemId, answer: 'Web', question: q.title,
            }])}\n</send_user_message_question_reply>` },
        ] }
        const history = { turns: [questionTurn, { id: 'answer-turn', status: 'completed', items: [nativeAnswer] }] }
        questions.history('native', history)
        const answerResultId = `codex:native:${q.id}:resolved`
        expect(store.messages.getLocalMessageStates(session.id, [answerResultId])).toEqual([])
        await projection.history(history)
        const ids = store.messages.getAllMessages(session.id).map(message => message.localId)
        expect(ids.indexOf('answer-remote')).toBeGreaterThanOrEqual(0)
        expect(ids.indexOf(answerResultId)).toBeGreaterThan(ids.indexOf('answer-remote'))
        const gateway = (engine as unknown as { rpcGateway: {
            rewindConversation: () => Promise<unknown>
            completeConversationRewind: (sessionId: string, token: string) => Promise<void>
        } }).rpcGateway
        gateway.rewindConversation = async () => ({ success: true, truncateFromLocalId: 'answer-remote', rewindToken: 'rewind-answer' })
        gateway.completeConversationRewind = async () => {}
        expect(await engine.rewindConversation(session.id, 'default', 'answer-remote')).toEqual({ type: 'success' })
        expect(store.messages.getLocalMessageStates(session.id, ['answer-remote', answerResultId])).toEqual([])
        expect(store.messages.getAllMessages(session.id).some(message => JSON.stringify(message.content).includes(q.title))).toBe(true)
    } finally { engine.stop(); store.close() }
})
