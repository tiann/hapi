import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveCodexSubagentNickname } from './spawnNicknameResolver';

describe('resolveCodexSubagentNickname', () => {
    let testDir: string;

    beforeEach(async () => {
        testDir = join(tmpdir(), `codex-nickname-${Date.now()}`);
        await mkdir(join(testDir, 'sessions', '2026', '04', '22'), { recursive: true });
    });

    afterEach(async () => {
        await rm(testDir, { recursive: true, force: true });
    });

    it('reads nickname from child transcript session metadata', async () => {
        const agentId = '019db5e6-d00a-7060-998e-bc6e4513f6cb';
        await writeFile(
            join(testDir, 'sessions', '2026', '04', '22', `rollout-2026-04-22T23-54-55-${agentId}.jsonl`),
            JSON.stringify({
                type: 'session_meta',
                payload: {
                    id: agentId,
                    agent_nickname: 'Ptolemy',
                    source: {
                        subagent: {
                            thread_spawn: {
                                agent_nickname: 'Ptolemy'
                            }
                        }
                    }
                }
            }) + '\n'
        );

        await expect(resolveCodexSubagentNickname(agentId, { codexHomeDir: testDir })).resolves.toBe('Ptolemy');
    });
});
