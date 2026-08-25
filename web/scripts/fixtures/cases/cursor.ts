import type { FixtureCase } from '../fixtureTypes'
import { T0, wireMessage } from './support'

/**
 * Cursor flavor: rides the generic codex envelope for text/reasoning/tools
 * (identical wire shapes — no separate fixtures needed for those), but its
 * ACP plan snapshot uses data.type === 'plan' with `entries`, which the
 * pipeline maps to a dedicated completed update_plan card keyed
 * 'cursor-plan-state' (vs codex's 'plan_update' → 'codex-plan-state').
 * Copilot has no distinct shapes at all (same convertAgentMessage path).
 */
export const cursorCases: FixtureCase[] = [
    {
        name: 'cursor-plan-snapshot',
        description: 'Cursor ACP plan message (data.type plan, entries[{content, status}]) becomes a completed update_plan tool-call with the stable id cursor-plan-state; input and result both carry {plan: [{step, status}], source: cursor} and later snapshots would merge into the same card.',
        messages: [
            wireMessage({
                id: 'msg-user-741',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'Fix the crash on empty sessions.' }
                }
            }),
            wireMessage({
                id: 'msg-cursor-742',
                seq: 2,
                createdAt: T0 + 2_900,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'plan',
                            entries: [
                                { content: 'Reproduce the crash', status: 'completed' },
                                { content: 'Fix the null check in session list', status: 'in_progress' },
                                { content: 'Add a regression test', status: 'pending' }
                            ],
                            id: 'cursor-plan-0a1b2c'
                        }
                    }
                }
            })
        ]
    }
]
