import { describe, expect, it } from 'vitest';
import { OpencodeConversationHistory } from './conversationHistory';

describe('OpenCode rewind capability is runtime and native-contract bound', () => {
    it.each([false, true])('requires both native revert routes as well as durable handler consumption (routes=%s)', async (routes) => {
        const history = new OpencodeConversationHistory(() => ({ baseUrl: 'http://native', sessionId: 'native', mode: 'v2' }),
            async () => Response.json({ paths: { '/api/session/{sessionID}/fork': {}, ...(routes ? {
                '/api/session/{sessionID}/revert/stage': {}, '/api/session/{sessionID}/revert/commit': {}
            } : {}) } }));
        await history.probeCapabilities();
        expect(history.getCapabilitiesForMetadata()?.conversationHistory?.rewindToMessage).not.toBe(true);
        history.setRewindReady(true);
        expect(history.getCapabilitiesForMetadata()?.conversationHistory?.rewindToMessage === true).toBe(routes);
        await history.disableFork();
        history.setRewindReady(true);
        expect(history.getCapabilitiesForMetadata()?.conversationHistory?.rewindToMessage).not.toBe(true);
    });
});
