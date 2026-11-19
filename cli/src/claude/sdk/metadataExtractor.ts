/**
 * SDK Metadata Extractor
 * Captures available tools and slash commands from Claude SDK initialization
 */

import { query } from './query'
import type { SDKSystemMessage } from './types'
import { logger } from '@/ui/logger'
import type { SkillSummary } from '@/modules/common/skills'

export interface SDKMetadata {
    tools?: string[]
    skills?: string[]
    slashCommands?: string[]
}

const CATALOG_FLAGS = new Set([
    '--bare',
    '--disable-slash-commands',
    '--safe-mode'
])
const CATALOG_VALUE_FLAGS = new Set([
    '--add-dir',
    '--plugin-dir',
    '--plugin-url',
    '--settings',
    '--setting-sources'
])

export function filterCatalogAffectingClaudeArgs(args: readonly string[] | undefined): string[] {
    if (!args) return []
    const filtered: string[] = []
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        const equalsIndex = arg.indexOf('=')
        if (CATALOG_FLAGS.has(arg) || (equalsIndex > 0 && CATALOG_VALUE_FLAGS.has(arg.slice(0, equalsIndex)))) {
            filtered.push(arg)
            continue
        }
        if (!CATALOG_VALUE_FLAGS.has(arg)) continue
        filtered.push(arg)
        while (i + 1 < args.length && !args[i + 1].startsWith('-')) {
            filtered.push(args[++i])
            if (arg !== '--add-dir') break
        }
    }
    return filtered
}

export function classifyClaudeSlashCatalog(
    names: readonly string[] | undefined,
    discoveredSkills: readonly SkillSummary[],
    loadedSkillNames?: readonly string[]
): { commands: string[]; skills: SkillSummary[] } {
    const skillsByName = new Map(discoveredSkills.map((skill) => [skill.name, skill]))
    const loadedSkills = loadedSkillNames ? new Set(loadedSkillNames) : null
    const commands: string[] = []
    const skills: SkillSummary[] = []

    for (const rawName of names ?? []) {
        const name = rawName.trim()
        if (!name) continue
        const localName = name.slice(name.lastIndexOf(':') + 1)
        const discoveredSkill = skillsByName.get(name) ?? skillsByName.get(localName)
        if (loadedSkills?.has(name) || (!loadedSkills && discoveredSkill)) {
            skills.push({ name, description: discoveredSkill?.description })
        } else {
            commands.push(name)
        }
    }

    return { commands, skills }
}

/**
 * Extract SDK metadata by running a minimal query and capturing the init message
 * @returns SDK metadata containing tools and slash commands
 */
export async function extractSDKMetadata(options: {
    cwd?: string
    claudeArgs?: readonly string[]
} = {}): Promise<SDKMetadata> {
    const abortController = new AbortController()
    const timeout = setTimeout(() => abortController.abort(), 10_000)
    
    try {
        logger.debug('[metadataExtractor] Starting SDK metadata extraction')
        
        // Run SDK with minimal tools allowed
        const sdkQuery = query({
            prompt: 'hello',
            options: {
                cwd: options.cwd,
                additionalArgs: filterCatalogAffectingClaudeArgs(options.claudeArgs),
                allowedTools: ['Bash(echo)'],
                maxTurns: 1,
                abort: abortController.signal
            }
        })

        // Wait for the first system message which contains tools and slash commands
        for await (const message of sdkQuery) {
            if (message.type === 'system' && message.subtype === 'init') {
                const systemMessage = message as SDKSystemMessage
                
                const metadata: SDKMetadata = {
                    tools: systemMessage.tools,
                    skills: systemMessage.skills,
                    slashCommands: systemMessage.slash_commands
                }
                
                logger.debug('[metadataExtractor] Captured SDK metadata:', metadata)
                
                // Abort the query since we got what we need
                abortController.abort()
                
                return metadata
            }
        }
        
        logger.debug('[metadataExtractor] No init message received from SDK')
        return {}
        
    } catch (error) {
        // Check if it's an abort error (expected)
        if (error instanceof Error && error.name === 'AbortError') {
            logger.debug('[metadataExtractor] SDK query aborted after capturing metadata')
            return {}
        }
        logger.debug('[metadataExtractor] Error extracting SDK metadata:', error)
        return {}
    } finally {
        clearTimeout(timeout)
    }
}
