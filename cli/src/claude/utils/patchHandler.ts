/**
 * Silent in-place patch handler for mermaid / markdown-table render failures.
 *
 * When the web client detects a broken code block it fires a patch-request to
 * the hub, which forwards a patch-prompt to the CLI over the socket.  This
 * module handles that event by making a *silent* single-turn call to the
 * underlying Claude agent (no conversation history side-effects) and returning
 * the corrected block via patch-response.
 */

import { query } from '@/claude/sdk/query'
import { logger } from '@/ui/logger'
import type { ApiSessionClient } from '@/api/apiSession'

const MERMAID_PROMPT = (failedCode: string) =>
    `The following mermaid block failed to render. Return ONLY the corrected mermaid block enclosed in a fenced \`\`\`mermaid ... \`\`\` code fence. Do not include any prose or explanation.\n\n\`\`\`mermaid\n${failedCode}\n\`\`\``

const TABLE_PROMPT = (failedCode: string) =>
    `The following markdown table failed to render. Return ONLY the corrected table in valid GFM markdown format. Do not include any prose or explanation.\n\n${failedCode}`

/**
 * Extract the first fenced code block matching the given language tag, or the
 * entire text if no fence is found.
 */
function extractFirstBlock(text: string, lang?: string): string {
    const fence = lang ? new RegExp('```' + lang + '\\s*\\n([\\s\\S]*?)\\n```', 'i') : /```[^\n]*\n([\s\S]*?)\n```/
    const match = text.match(fence)
    if (match) {
        return match[1].trim()
    }
    // Fallback: strip any leading/trailing fences and return
    return text.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '').trim()
}

export interface PatchHandlerConfig {
    cwd: string
    model?: string | null
    claudeEnvVars?: Record<string, string>
    claudeArgs?: string[]
}

export function registerPatchHandler(
    session: ApiSessionClient,
    config: PatchHandlerConfig
): void {
    session.onPatchPrompt(async (payload) => {
        const { msgId, blockIndex, type, failedCode } = payload
        logger.debug(`[patch] received patch-prompt: msgId=${msgId} blockIndex=${blockIndex} type=${type}`)

        const prompt = type === 'mermaid'
            ? MERMAID_PROMPT(failedCode)
            : TABLE_PROMPT(failedCode)

        try {
            const q = query({
                prompt,
                options: {
                    cwd: config.cwd,
                    maxTurns: 1,
                    allowedTools: [],
                    model: config.model ?? undefined,
                    permissionMode: 'bypassPermissions'
                }
            })

            let correctedCode = ''

            for await (const message of q) {
                if (message.type === 'assistant') {
                    const msg = message as { message?: { content?: unknown[] } }
                    if (Array.isArray(msg.message?.content)) {
                        for (const block of msg.message.content) {
                            const b = block as { type?: string; text?: string }
                            if (b.type === 'text' && typeof b.text === 'string') {
                                correctedCode += b.text
                            }
                        }
                    }
                }
            }

            correctedCode = correctedCode.trim()
            if (!correctedCode) {
                logger.debug(`[patch] empty response from agent, skipping patch-response`)
                return
            }

            // Extract only the code block (strip prose / fences)
            const extracted = type === 'mermaid'
                ? extractFirstBlock(correctedCode, 'mermaid')
                : extractFirstBlock(correctedCode)

            if (!extracted) {
                logger.debug(`[patch] could not extract corrected block, skipping`)
                return
            }

            logger.debug(`[patch] sending patch-response for msgId=${msgId} blockIndex=${blockIndex}`)
            session.sendPatchResponse({ msgId, blockIndex, correctedCode: extracted })
        } catch (err) {
            logger.debug(`[patch] agent call failed: ${err instanceof Error ? err.message : String(err)}`)
        }
    })
}
