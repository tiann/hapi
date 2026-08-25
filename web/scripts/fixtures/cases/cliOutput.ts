import type { FixtureCase } from '../fixtureTypes'
import { T0, wireMessage } from './support'

/**
 * cli-output blocks: local slash-command turns mirrored from the agent
 * transcript arrive as plain user text with meta.sentFrom === 'cli' and
 * <command-name>/<command-message>/<command-args>/<local-command-stdout> tags
 * (web/src/chat/reducerCliOutput.ts). Tag detection requires BOTH the cli
 * origin and a tag; the stdout follow-up merges into the preceding
 * command-name block of the same source.
 */
export const cliOutputCases: FixtureCase[] = [
    {
        name: 'cli-output-user-command',
        description: 'A user message with meta.sentFrom cli whose text carries command tags becomes a cli-output block with source user (not a user-text block); the tag markup is carried verbatim.',
        messages: [
            wireMessage({
                id: 'msg-cli-701',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: '<command-name>/status</command-name>\n<command-message>status</command-message>\n<command-args></command-args>'
                    },
                    meta: { sentFrom: 'cli' }
                }
            })
        ]
    },
    {
        name: 'cli-output-command-stdout-merge',
        description: 'Two consecutive cli-origin user messages — a command-name block without stdout followed by a <local-command-stdout> block — merge into ONE cli-output block (id/localId of the first, texts joined with a newline).',
        messages: [
            wireMessage({
                id: 'msg-cli-711',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: '<command-name>/context</command-name>\n<command-message>context</command-message>\n<command-args></command-args>'
                    },
                    meta: { sentFrom: 'cli' }
                }
            }),
            wireMessage({
                id: 'msg-cli-712',
                seq: 2,
                createdAt: T0 + 700,
                content: {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: '<local-command-stdout>Context usage: 84k/200k tokens (42%)</local-command-stdout>'
                    },
                    meta: { sentFrom: 'cli' }
                }
            })
        ]
    }
]
