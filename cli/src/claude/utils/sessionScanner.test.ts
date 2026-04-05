import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createSessionScanner } from './sessionScanner'
import { RawJSONLines } from '../types'
import { mkdir, writeFile, appendFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { existsSync } from 'node:fs'

function getMessageText(message: RawJSONLines): string | null {
  if (message.type === 'summary') {
    return message.summary
  }

  if (message.type === 'system') {
    return null
  }

  if (!message.message) {
    return null
  }

  const content = message.message.content
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return null
  }

  return content
    .map((block) => block && typeof block === 'object' && 'text' in block && typeof block.text === 'string'
      ? block.text
      : null)
    .filter((value): value is string => value !== null)
    .join(' ')
}

describe('sessionScanner', () => {
  let testDir: string
  let projectDir: string
  let collectedMessages: RawJSONLines[]
  let scanner: Awaited<ReturnType<typeof createSessionScanner>> | null = null
  
  beforeEach(async () => {
    testDir = join(tmpdir(), `scanner-test-${Date.now()}`)
    await mkdir(testDir, { recursive: true })
    
    const projectName = testDir.replace(/\//g, '-')
    projectDir = join(homedir(), '.claude', 'projects', projectName)
    await mkdir(projectDir, { recursive: true })
    
    collectedMessages = []
  })
  
  afterEach(async () => {
    // Clean up scanner
    if (scanner) {
      await scanner.cleanup()
      scanner = null
    }
    
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true })
    }
    if (existsSync(projectDir)) {
      await rm(projectDir, { recursive: true, force: true })
    }
  })

  async function writeSessionLog(sessionId: string, messages: Array<Record<string, unknown>>): Promise<void> {
    await writeFile(
      join(projectDir, `${sessionId}.jsonl`),
      `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`
    )
  }
  
  it('should process initial session and resumed session correctly', async () => {
    // TEST SCENARIO:
    // Phase 1: User says "lol" → Assistant responds "lol" → Session closes
    // Phase 2: User resumes with NEW session ID → User says "run ls tool" → Assistant runs LS tool → Shows files
    // 
    // Key point: When resuming, Claude creates a NEW session file with:
    // - Summary line
    // - Complete history from previous session (with NEW session ID)
    // - New messages
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg)
    })
    
    // PHASE 1: Initial session (0-say-lol-session.jsonl)
    const fixture1 = await readFile(join(__dirname, '__fixtures__', '0-say-lol-session.jsonl'), 'utf-8')
    const lines1 = fixture1.split('\n').filter(line => line.trim())
    
    const sessionId1 = '93a9705e-bc6a-406d-8dce-8acc014dedbd'
    const sessionFile1 = join(projectDir, `${sessionId1}.jsonl`)
    
    // Write first line
    await writeFile(sessionFile1, lines1[0] + '\n')
    scanner.onNewSession(sessionId1)
    await new Promise(resolve => setTimeout(resolve, 100))
    
    expect(collectedMessages).toHaveLength(1)
    expect(collectedMessages[0].type).toBe('user')
    if (collectedMessages[0].type === 'user') {
      const content = collectedMessages[0].message.content
      const text = typeof content === 'string' ? content : (content as any)[0].text
      expect(text).toBe('say lol')
    }
    
    // Write second line with delay
    await new Promise(resolve => setTimeout(resolve, 50))
    await appendFile(sessionFile1, lines1[1] + '\n')
    await new Promise(resolve => setTimeout(resolve, 200))
    
    expect(collectedMessages).toHaveLength(2)
    expect(collectedMessages[1].type).toBe('assistant')
    if (collectedMessages[1].type === 'assistant' && collectedMessages[1].message) {
      expect((collectedMessages[1].message.content as any)[0].text).toBe('lol')
    }
    
    // PHASE 2: Resumed session (1-continue-run-ls-tool.jsonl)
    const fixture2 = await readFile(join(__dirname, '__fixtures__', '1-continue-run-ls-tool.jsonl'), 'utf-8')
    const lines2 = fixture2.split('\n').filter(line => line.trim())
    
    const sessionId2 = '789e105f-ae33-486d-9271-0696266f072d'
    const sessionFile2 = join(projectDir, `${sessionId2}.jsonl`)
    
    // Reset collected messages count for clarity
    const phase1Count = collectedMessages.length
    
    // Write summary + historical messages (lines 0-2) - NOT line 3 which is new
    let initialContent = ''
    for (let i = 0; i <= 2; i++) {
      initialContent += lines2[i] + '\n'
    }
    await writeFile(sessionFile2, initialContent)
    
    scanner.onNewSession(sessionId2)
    await new Promise(resolve => setTimeout(resolve, 100))
    
    // Should have added only 1 new message (summary) 
    // The historical user + assistant messages (lines 1-2) are deduplicated because they have same UUIDs
    expect(collectedMessages).toHaveLength(phase1Count + 1)
    expect(collectedMessages[phase1Count].type).toBe('summary')
    
    // Write new messages (user asks for ls tool) - this is line 3
    await new Promise(resolve => setTimeout(resolve, 50))
    await appendFile(sessionFile2, lines2[3] + '\n')
    await new Promise(resolve => setTimeout(resolve, 200))
    
    // Find the user message we just added
    const userMessages = collectedMessages.filter(m => m.type === 'user')
    const lastUserMsg = userMessages[userMessages.length - 1]
    expect(lastUserMsg).toBeDefined()
    if (lastUserMsg && lastUserMsg.type === 'user') {
      expect(lastUserMsg.message.content).toBe('run ls tool ')
    }
    
    // Write remaining lines (assistant tool use, tool result, final assistant message) - starting from line 4
    for (let i = 4; i < lines2.length; i++) {
      await new Promise(resolve => setTimeout(resolve, 50))
      await appendFile(sessionFile2, lines2[i] + '\n')
    }
    await new Promise(resolve => setTimeout(resolve, 300))
    
    // Final count check
    const finalMessages = collectedMessages.slice(phase1Count)
    
    // Should have: 1 summary + 0 history (deduplicated) + 4 new messages = 5 total for session 2
    expect(finalMessages.length).toBeGreaterThanOrEqual(5)
    
    // Verify last message is assistant with the file listing
    const lastAssistantMsg = collectedMessages[collectedMessages.length - 1]
    expect(lastAssistantMsg.type).toBe('assistant')
    if (lastAssistantMsg.type === 'assistant' && lastAssistantMsg.message?.content) {
      const content = (lastAssistantMsg.message.content as any)[0].text
      expect(content).toContain('0-say-lol-session.jsonl')
      expect(content).toContain('readme.md')
    }
  })

  it('links child Claude transcript messages to the parent Task sidechain', async () => {
    await writeSessionLog('parent-session', [
      {
        type: 'assistant',
        uuid: 'parent-task-call',
        parentUuid: null,
        sessionId: 'parent-session',
        timestamp: '2026-04-04T00:00:00.000Z',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'task-1',
            name: 'Task',
            input: {
              prompt: 'Investigate flaky test'
            }
          }]
        }
      }
    ])

    await writeSessionLog('child-session', [
      {
        type: 'user',
        uuid: 'child-user-1',
        parentUuid: null,
        sessionId: 'child-session',
        timestamp: '2026-04-04T00:00:01.000Z',
        message: {
          role: 'user',
          content: 'Investigate flaky test'
        }
      },
      {
        type: 'assistant',
        uuid: 'child-assistant-1',
        parentUuid: 'child-user-1',
        sessionId: 'child-session',
        timestamp: '2026-04-04T00:00:02.000Z',
        message: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: 'Root cause is a stale retry cache key.'
          }]
        }
      }
    ])

    scanner = await createSessionScanner({
      sessionId: 'parent-session',
      workingDirectory: testDir,
      onMessage: (message) => collectedMessages.push(message),
      replayExistingMessages: true
    })

    await scanner.cleanup()
    scanner = null

    const linkedMessages = collectedMessages.filter((message) => {
      const subagent = message.meta?.subagent as Record<string, unknown> | undefined
      return subagent?.sidechainKey === 'task-1'
    })

    expect(linkedMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'user',
        sessionId: 'child-session',
        isSidechain: true,
        meta: expect.objectContaining({
          subagent: expect.objectContaining({
            kind: 'message',
            sidechainKey: 'task-1'
          })
        })
      }),
      expect.objectContaining({
        type: 'assistant',
        sessionId: 'child-session',
        isSidechain: true,
        meta: expect.objectContaining({
          subagent: expect.objectContaining({
            kind: 'message',
            sidechainKey: 'task-1'
          })
        })
      })
    ]))
  })

  it('dedupes replayed linked child transcript messages that were already materialized in the parent transcript', async () => {
    await writeSessionLog('parent-session', [
      {
        type: 'assistant',
        uuid: 'parent-task-call',
        parentUuid: null,
        sessionId: 'parent-session',
        timestamp: '2026-04-04T00:00:00.000Z',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'task-1',
            name: 'Task',
            input: {
              prompt: 'Investigate flaky test'
            }
          }]
        }
      },
      {
        type: 'user',
        uuid: 'materialized-child-user',
        parentUuid: null,
        sessionId: 'parent-session',
        isSidechain: true,
        timestamp: '2026-04-04T00:00:01.000Z',
        meta: {
          subagent: {
            kind: 'message',
            sidechainKey: 'task-1'
          }
        },
        message: {
          role: 'user',
          content: 'Investigate flaky test'
        }
      },
      {
        type: 'assistant',
        uuid: 'materialized-child-assistant',
        parentUuid: 'materialized-child-user',
        sessionId: 'parent-session',
        isSidechain: true,
        timestamp: '2026-04-04T00:00:02.000Z',
        meta: {
          subagent: {
            kind: 'message',
            sidechainKey: 'task-1'
          }
        },
        message: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: 'Working on it now.'
          }]
        }
      }
    ])

    await writeSessionLog('child-session', [
      {
        type: 'user',
        uuid: 'child-user-1',
        parentUuid: null,
        sessionId: 'child-session',
        timestamp: '2026-04-04T00:00:03.000Z',
        message: {
          role: 'user',
          content: 'Investigate flaky test'
        }
      },
      {
        type: 'assistant',
        uuid: 'child-assistant-1',
        parentUuid: 'child-user-1',
        sessionId: 'child-session',
        timestamp: '2026-04-04T00:00:04.000Z',
        message: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: 'Working on it now.'
          }]
        }
      },
      {
        type: 'assistant',
        uuid: 'child-assistant-2',
        parentUuid: 'child-assistant-1',
        sessionId: 'child-session',
        timestamp: '2026-04-04T00:00:05.000Z',
        message: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: 'Found the failing fixture.'
          }]
        }
      }
    ])

    scanner = await createSessionScanner({
      sessionId: 'parent-session',
      workingDirectory: testDir,
      onMessage: (message) => collectedMessages.push(message),
      replayExistingMessages: true
    })

    await scanner.cleanup()
    scanner = null

    const taskMessages = collectedMessages.filter((message) => {
      const subagent = message.meta?.subagent as Record<string, unknown> | undefined
      return subagent?.sidechainKey === 'task-1'
    })

    expect(taskMessages.filter((message) => getMessageText(message) === 'Investigate flaky test')).toHaveLength(1)
    expect(taskMessages.filter((message) => getMessageText(message) === 'Working on it now.')).toHaveLength(1)
    expect(taskMessages).toContainEqual(expect.objectContaining({
      type: 'assistant',
      sessionId: 'child-session',
      isSidechain: true,
      meta: expect.objectContaining({
        subagent: expect.objectContaining({
          sidechainKey: 'task-1'
        })
      }),
      message: expect.objectContaining({
        content: [{
          type: 'text',
          text: 'Found the failing fixture.'
        }]
      })
    }))
  })

  it('does not guess a child link when repeated Task prompts are ambiguous', async () => {
    await writeSessionLog('parent-session', [
      {
        type: 'assistant',
        uuid: 'parent-task-call-1',
        parentUuid: null,
        sessionId: 'parent-session',
        timestamp: '2026-04-04T00:00:00.000Z',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'task-1',
            name: 'Task',
            input: {
              prompt: 'Investigate flaky test'
            }
          }]
        }
      },
      {
        type: 'assistant',
        uuid: 'parent-task-call-2',
        parentUuid: 'parent-task-call-1',
        sessionId: 'parent-session',
        timestamp: '2026-04-04T00:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'task-2',
            name: 'Task',
            input: {
              prompt: 'Investigate flaky test'
            }
          }]
        }
      }
    ])

    await writeSessionLog('child-session', [
      {
        type: 'user',
        uuid: 'child-user-1',
        parentUuid: null,
        sessionId: 'child-session',
        timestamp: '2026-04-04T00:00:02.000Z',
        message: {
          role: 'user',
          content: 'Investigate flaky test'
        }
      },
      {
        type: 'assistant',
        uuid: 'child-assistant-1',
        parentUuid: 'child-user-1',
        sessionId: 'child-session',
        timestamp: '2026-04-04T00:00:03.000Z',
        message: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: 'Potentially unrelated child transcript.'
          }]
        }
      }
    ])

    scanner = await createSessionScanner({
      sessionId: 'parent-session',
      workingDirectory: testDir,
      onMessage: (message) => collectedMessages.push(message),
      replayExistingMessages: true
    })

    await scanner.cleanup()
    scanner = null

    expect(collectedMessages.some((message) => message.sessionId === 'child-session')).toBe(false)
    expect(collectedMessages.some((message) => {
      const subagent = message.meta?.subagent as Record<string, unknown> | undefined
      return subagent?.sidechainKey === 'task-1' || subagent?.sidechainKey === 'task-2'
    })).toBe(false)
  })

  it('keeps repeated identical linked child transcript messages when they are distinct events', async () => {
    await writeSessionLog('parent-session', [
      {
        type: 'assistant',
        uuid: 'parent-task-call',
        parentUuid: null,
        sessionId: 'parent-session',
        timestamp: '2026-04-04T00:00:00.000Z',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'task-1',
            name: 'Task',
            input: {
              prompt: 'Investigate flaky test'
            }
          }]
        }
      }
    ])

    await writeSessionLog('child-session', [
      {
        type: 'user',
        uuid: 'child-user-1',
        parentUuid: null,
        sessionId: 'child-session',
        timestamp: '2026-04-04T00:00:01.000Z',
        message: {
          role: 'user',
          content: 'Investigate flaky test'
        }
      },
      {
        type: 'assistant',
        uuid: 'child-assistant-1',
        parentUuid: 'child-user-1',
        sessionId: 'child-session',
        timestamp: '2026-04-04T00:00:02.000Z',
        message: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: 'Still investigating.'
          }]
        }
      },
      {
        type: 'assistant',
        uuid: 'child-assistant-2',
        parentUuid: 'child-assistant-1',
        sessionId: 'child-session',
        timestamp: '2026-04-04T00:00:03.000Z',
        meta: {
          subagent: {
            kind: 'status',
            status: 'running'
          }
        },
        message: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: 'Still investigating.'
          }]
        }
      }
    ])

    scanner = await createSessionScanner({
      sessionId: 'parent-session',
      workingDirectory: testDir,
      onMessage: (message) => collectedMessages.push(message),
      replayExistingMessages: true
    })

    await scanner.cleanup()
    scanner = null

    const repeatedMessages = collectedMessages.filter((message) => (
      message.sessionId === 'child-session'
      && getMessageText(message) === 'Still investigating.'
    ))

    expect(repeatedMessages).toHaveLength(2)
    expect(repeatedMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        uuid: 'child-assistant-1',
        meta: expect.objectContaining({
          subagent: expect.objectContaining({
            kind: 'message',
            sidechainKey: 'task-1'
          })
        })
      }),
      expect.objectContaining({
        uuid: 'child-assistant-2',
        meta: expect.objectContaining({
          subagent: expect.objectContaining({
            kind: 'status',
            status: 'running',
            sidechainKey: 'task-1'
          })
        })
      })
    ]))
  })
})
