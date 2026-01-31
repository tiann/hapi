import { describe, expect, it } from 'bun:test'

function extractUsageFromMessage(content: unknown): import('@hapi/protocol').MessageUsage | undefined {
    if (!content || typeof content !== 'object') return undefined

    if ('usage' in content && typeof content.usage === 'object' && content.usage !== null) {
        const usage = content.usage as Record<string, unknown>
        const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined
        const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined
        const cacheCreation = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : undefined
        const cacheRead = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : undefined
        const serviceTier = typeof usage.service_tier === 'string' ? usage.service_tier : undefined

        if (inputTokens !== undefined && outputTokens !== undefined) {
            return {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                cache_creation_input_tokens: cacheCreation,
                cache_read_input_tokens: cacheRead,
                service_tier: serviceTier
            }
        }
    }

    if ('content' in content && typeof content.content === 'object' && content.content !== null) {
        const contentObj = content.content as Record<string, unknown>
        if ('type' in contentObj && contentObj.type === 'output' && 'data' in contentObj) {
            const data = contentObj.data as Record<string, unknown>
            if ('message' in data && typeof data.message === 'object' && data.message !== null) {
                const message = data.message as Record<string, unknown>
                if ('usage' in message && typeof message.usage === 'object' && message.usage !== null) {
                    const usage = message.usage as Record<string, unknown>
                    const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined
                    const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined
                    const cacheCreation = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : undefined
                    const cacheRead = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : undefined
                    const serviceTier = typeof usage.service_tier === 'string' ? usage.service_tier : undefined

                    if (inputTokens !== undefined && outputTokens !== undefined) {
            return {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                cache_creation_input_tokens: cacheCreation,
                cache_read_input_tokens: cacheRead,
                service_tier: serviceTier
            }
                    }
                }
            }
        }
    }

    return undefined
}

describe('extractUsageFromMessage', () => {
    describe('Claude format', () => {
        it('extracts usage from Claude with required fields only', () => {
            const content = {
                usage: {
                    input_tokens: 100,
                    output_tokens: 200
                }
            }

            const result = extractUsageFromMessage(content)
            expect(result).toEqual({
                input_tokens: 100,
                output_tokens: 200,
                cache_creation_input_tokens: undefined,
                cache_read_input_tokens: undefined,
                service_tier: undefined
            })
        })

        it('extracts usage from Claude with all fields', () => {
            const content = {
                usage: {
                    input_tokens: 100,
                    output_tokens: 200,
                    cache_creation_input_tokens: 50,
                    cache_read_input_tokens: 75,
                    service_tier: 'tier-1'
                }
            }

            const result = extractUsageFromMessage(content)
            expect(result).toEqual({
                input_tokens: 100,
                output_tokens: 200,
                cache_creation_input_tokens: 50,
                cache_read_input_tokens: 75,
                service_tier: 'tier-1'
            })
        })

        it('extracts usage with partial cache fields', () => {
            const content = {
                usage: {
                    input_tokens: 100,
                    output_tokens: 200,
                    cache_creation_input_tokens: 50
                }
            }

            const result = extractUsageFromMessage(content)
            expect(result).toEqual({
                input_tokens: 100,
                output_tokens: 200,
                cache_creation_input_tokens: 50,
                cache_read_input_tokens: undefined,
                service_tier: undefined
            })
        })

        it('returns undefined when usage has missing required fields', () => {
            const content = {
                usage: {
                    input_tokens: 100
                }
            }

            const result = extractUsageFromMessage(content)
            expect(result).toBeUndefined()
        })

        it('returns undefined when usage is null', () => {
            const content = {
                usage: null
            }

            const result = extractUsageFromMessage(content)
            expect(result).toBeUndefined()
        })

        it('returns undefined when usage is not an object', () => {
            const content = {
                usage: 'not-an-object'
            }

            const result = extractUsageFromMessage(content)
            expect(result).toBeUndefined()
        })
    })

    describe('Codex format', () => {
        it('extracts usage from nested Codex format', () => {
            const content = {
                content: {
                    type: 'output',
                    data: {
                        message: {
                            usage: {
                                input_tokens: 100,
                                output_tokens: 200
                            }
                        }
                    }
                }
            }

            const result = extractUsageFromMessage(content)
            expect(result).toEqual({
                input_tokens: 100,
                output_tokens: 200,
                cache_creation_input_tokens: undefined,
                cache_read_input_tokens: undefined,
                service_tier: undefined
            })
        })

        it('extracts usage from Codex with all fields', () => {
            const content = {
                content: {
                    type: 'output',
                    data: {
                        message: {
                            usage: {
                                input_tokens: 100,
                                output_tokens: 200,
                                cache_creation_input_tokens: 50,
                                cache_read_input_tokens: 75,
                                service_tier: 'tier-2'
                            }
                        }
                    }
                }
            }

            const result = extractUsageFromMessage(content)
            expect(result).toEqual({
                input_tokens: 100,
                output_tokens: 200,
                cache_creation_input_tokens: 50,
                cache_read_input_tokens: 75,
                service_tier: 'tier-2'
            })
        })

        it('returns undefined when content type is not output', () => {
            const content = {
                content: {
                    type: 'input',
                    data: {
                        message: {
                            usage: {
                                input_tokens: 100,
                                output_tokens: 200
                            }
                        }
                    }
                }
            }

            const result = extractUsageFromMessage(content)
            expect(result).toBeUndefined()
        })

        it('returns undefined when message is missing in data', () => {
            const content = {
                content: {
                    type: 'output',
                    data: {}
                }
            }

            const result = extractUsageFromMessage(content)
            expect(result).toBeUndefined()
        })

        it('returns undefined when usage is missing in nested message', () => {
            const content = {
                content: {
                    type: 'output',
                    data: {
                        message: {}
                    }
                }
            }

            const result = extractUsageFromMessage(content)
            expect(result).toBeUndefined()
        })
    })

    describe('Edge cases', () => {
        it('returns undefined for null content', () => {
            const result = extractUsageFromMessage(null)
            expect(result).toBeUndefined()
        })

        it('returns undefined for undefined content', () => {
            const result = extractUsageFromMessage(undefined)
            expect(result).toBeUndefined()
        })

        it('returns undefined for string content', () => {
            const result = extractUsageFromMessage('string')
            expect(result).toBeUndefined()
        })

        it('returns undefined for number content', () => {
            const result = extractUsageFromMessage(123)
            expect(result).toBeUndefined()
        })

        it('returns undefined for array content', () => {
            const result = extractUsageFromMessage([])
            expect(result).toBeUndefined()
        })

        it('returns undefined for empty object', () => {
            const result = extractUsageFromMessage({})
            expect(result).toBeUndefined()
        })

        it('ignores non-numeric input/output tokens', () => {
            const content = {
                usage: {
                    input_tokens: '100' as unknown,
                    output_tokens: 200
                }
            }

            const result = extractUsageFromMessage(content)
            expect(result).toBeUndefined()
        })

        it('ignores non-string service_tier', () => {
            const content = {
                usage: {
                    input_tokens: 100,
                    output_tokens: 200,
                    service_tier: 123 as unknown
                }
            }

            const result = extractUsageFromMessage(content)
            expect(result).toEqual({
                input_tokens: 100,
                output_tokens: 200,
                cache_creation_input_tokens: undefined,
                cache_read_input_tokens: undefined,
                service_tier: undefined
            })
        })
    })
})
