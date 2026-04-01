/**
 * Main query implementation for Claude Code SDK
 * Handles spawning Claude process and managing message streams
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { Stream } from './stream'
import {
    type QueryOptions,
    type QueryPrompt,
    type SDKMessage,
    type ControlResponseHandler,
    type SDKControlRequest,
    type ControlRequest,
    type SDKControlResponse,
    type CanCallToolCallback,
    type CanUseToolControlRequest,
    type CanUseToolControlResponse,
    type ControlCancelRequest,
    type PermissionResult,
    AbortError
} from './types'
import { getDefaultClaudeCodePath, logDebug, streamToStdin } from './utils'
import { withBunRuntimeEnv } from '@/utils/bunRuntime'
import { killProcessByChildProcess } from '@/utils/process'
import { stripNewlinesForWindowsShellArg } from '@/utils/shellEscape'
import type { Writable } from 'node:stream'
import { logger } from '@/ui/logger'
import { appendMcpConfigArg } from '../utils/mcpConfig'

const DEFAULT_PROMPT_FAILURE_CLEANUP_TIMEOUT_MS = 3_000

/**
 * Query class manages Claude Code process interaction
 */
export class Query implements AsyncIterableIterator<SDKMessage> {
    private pendingControlResponses = new Map<string, ControlResponseHandler>()
    private cancelControllers = new Map<string, AbortController>()
    private sdkMessages: AsyncIterableIterator<SDKMessage>
    private inputStream = new Stream<SDKMessage>()
    private canCallTool?: CanCallToolCallback
    private promptFailure: Error | null = null

    constructor(
        private childStdin: Writable | null,
        private childStdout: NodeJS.ReadableStream,
        private processExitPromise: Promise<void>,
        canCallTool?: CanCallToolCallback
    ) {
        this.canCallTool = canCallTool
        this.readMessages()
        this.sdkMessages = this.readSdkMessages()
    }

    /**
     * Set an error on the stream
     */
    setError(error: Error): void {
        this.inputStream.error(error)
    }

    registerPromptFailure(error: Error): boolean {
        if (this.promptFailure) {
            return false
        }
        this.promptFailure = error
        this.cleanupControllers()
        return true
    }

    getPromptFailure(): Error | null {
        return this.promptFailure
    }

    /**
     * AsyncIterableIterator implementation
     */
    next(...args: [] | [undefined]): Promise<IteratorResult<SDKMessage>> {
        return this.sdkMessages.next(...args)
    }

    return(value?: any): Promise<IteratorResult<SDKMessage>> {
        if (this.sdkMessages.return) {
            return this.sdkMessages.return(value)
        }
        return Promise.resolve({ done: true, value: undefined })
    }

    throw(e: any): Promise<IteratorResult<SDKMessage>> {
        if (this.sdkMessages.throw) {
            return this.sdkMessages.throw(e)
        }
        return Promise.reject(e)
    }

    [Symbol.asyncIterator](): AsyncIterableIterator<SDKMessage> {
        return this.sdkMessages
    }

    /**
     * Read messages from Claude process stdout
     */
    private async readMessages(): Promise<void> {
        const rl = createInterface({ input: this.childStdout })
        let hadError = false

        try {
            for await (const line of rl) {
                if (this.promptFailure) {
                    break
                }

                if (line.trim()) {
                    try {
                        const message = JSON.parse(line) as SDKMessage | SDKControlResponse

                        if (this.promptFailure) {
                            break
                        }

                        if (message.type === 'control_response') {
                            const controlResponse = message as SDKControlResponse
                            const handler = this.pendingControlResponses.get(controlResponse.response.request_id)
                            if (handler) {
                                handler(controlResponse.response)
                            }
                            continue
                        } else if (message.type === 'control_request') {
                            await this.handleControlRequest(message as unknown as CanUseToolControlRequest)
                            continue
                        } else if (message.type === 'control_cancel_request') {
                            this.handleControlCancelRequest(message as unknown as ControlCancelRequest)
                            continue
                        }

                        this.inputStream.enqueue(message)
                    } catch (e) {
                        logger.debug(line)
                    }
                }
            }
            await this.processExitPromise
        } catch (error) {
            hadError = true
            this.inputStream.error(error as Error)
        } finally {
            // Only call done() on clean exit - calling done() after error()
            // would mask the error since Stream.next() checks isDone before hasError
            if (!hadError && !this.inputStream.hasTerminalError) {
                this.inputStream.done()
            }
            this.cleanupControllers()
            rl.close()
        }
    }

    /**
     * Async generator for SDK messages
     */
    private async *readSdkMessages(): AsyncIterableIterator<SDKMessage> {
        for await (const message of this.inputStream) {
            yield message
        }
    }

    /**
     * Send interrupt request to Claude
     */
    async interrupt(): Promise<void> {
        if (!this.childStdin) {
            throw new Error('Interrupt requires --input-format stream-json')
        }

        await this.request({
            subtype: 'interrupt'
        }, this.childStdin)
    }

    /**
     * Send control request to Claude process
     */
    private request(request: ControlRequest, childStdin: Writable): Promise<SDKControlResponse['response']> {
        const requestId = Math.random().toString(36).substring(2, 15)
        const sdkRequest: SDKControlRequest = {
            request_id: requestId,
            type: 'control_request',
            request
        }

        return new Promise((resolve, reject) => {
            this.pendingControlResponses.set(requestId, (response) => {
                if (response.subtype === 'success') {
                    resolve(response)
                } else {
                    reject(new Error(response.error))
                }
            })

            childStdin.write(JSON.stringify(sdkRequest) + '\n')
        })
    }

    /**
     * Handle incoming control requests for tool permissions
     * Replicates the exact logic from the SDK's handleControlRequest method
     */
    private async handleControlRequest(request: CanUseToolControlRequest): Promise<void> {
        if (!this.childStdin) {
            logDebug('Cannot handle control request - no stdin available')
            return
        }

        const controller = new AbortController()
        this.cancelControllers.set(request.request_id, controller)

        try {
            const response = await this.processControlRequest(request, controller.signal)
            if (this.promptFailure || controller.signal.aborted || !this.childStdin?.writable) {
                return
            }
            const controlResponse: CanUseToolControlResponse = {
                type: 'control_response',
                response: {
                    subtype: 'success',
                    request_id: request.request_id,
                    response
                }
            }
            this.childStdin.write(JSON.stringify(controlResponse) + '\n')
        } catch (error) {
            if (this.promptFailure || controller.signal.aborted || !this.childStdin?.writable) {
                return
            }
            const controlErrorResponse: CanUseToolControlResponse = {
                type: 'control_response',
                response: {
                    subtype: 'error',
                    request_id: request.request_id,
                    error: error instanceof Error ? error.message : String(error)
                }
            }
            this.childStdin.write(JSON.stringify(controlErrorResponse) + '\n')
        } finally {
            this.cancelControllers.delete(request.request_id)
        }
    }

    /**
     * Handle control cancel requests
     * Replicates the exact logic from the SDK's handleControlCancelRequest method
     */
    private handleControlCancelRequest(request: ControlCancelRequest): void {
        const controller = this.cancelControllers.get(request.request_id)
        if (controller) {
            controller.abort()
            this.cancelControllers.delete(request.request_id)
        }
    }

    /**
     * Process control requests based on subtype
     * Replicates the exact logic from the SDK's processControlRequest method
     */
    private async processControlRequest(request: CanUseToolControlRequest, signal: AbortSignal): Promise<PermissionResult> {
        if (request.request.subtype === 'can_use_tool') {
            if (!this.canCallTool) {
                throw new Error('canCallTool callback is not provided.')
            }
            return this.canCallTool(request.request.tool_name, request.request.input, {
                signal
            })
        }
        
        throw new Error('Unsupported control request subtype: ' + request.request.subtype)
    }

    /**
     * Cleanup method to abort all pending control requests
     */
    private cleanupControllers(): void {
        for (const [requestId, controller] of this.cancelControllers.entries()) {
            controller.abort()
            this.cancelControllers.delete(requestId)
        }
    }
}

/**
 * Main query function to interact with Claude Code
 */
export function query(config: {
    prompt: QueryPrompt
    options?: QueryOptions
}): Query {
    const {
        prompt,
        options: {
            additionalDirectories = [],
            allowedTools = [],
            appendSystemPrompt,
            customSystemPrompt,
            cwd,
            disallowedTools = [],
            maxTurns,
            mcpServers,
            pathToClaudeCodeExecutable = getDefaultClaudeCodePath(),
            permissionMode = 'default',
            continue: continueConversation,
            resume,
            model,
            effort,
            fallbackModel,
            settingsPath,
            strictMcpConfig,
            canCallTool,
            promptFailureCleanupTimeoutMs = DEFAULT_PROMPT_FAILURE_CLEANUP_TIMEOUT_MS
        } = {}
    } = config

    // Set entrypoint if not already set
    if (!process.env.CLAUDE_CODE_ENTRYPOINT) {
        process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts'
    }

    // Build command arguments
    const args = ['--output-format', 'stream-json', '--verbose']
    let cleanupMcpConfig: (() => void) | null = null

    if (customSystemPrompt) args.push('--system-prompt', stripNewlinesForWindowsShellArg(customSystemPrompt))
    if (appendSystemPrompt) args.push('--append-system-prompt', stripNewlinesForWindowsShellArg(appendSystemPrompt))
    if (maxTurns) args.push('--max-turns', maxTurns.toString())
    if (model) args.push('--model', model)
    if (effort) args.push('--effort', effort)
    if (canCallTool) {
        if (typeof prompt === 'string') {
            throw new Error('canCallTool callback requires --input-format stream-json. Please set prompt as an AsyncIterable.')
        }
        args.push('--permission-prompt-tool', 'stdio')
    }
    if (continueConversation) args.push('--continue')
    if (resume) args.push('--resume', resume)
    if (settingsPath) args.push('--settings', settingsPath)
    if (allowedTools.length > 0) args.push('--allowedTools', allowedTools.join(','))
    if (disallowedTools.length > 0) args.push('--disallowedTools', disallowedTools.join(','))
    if (additionalDirectories.length > 0) args.push('--add-dir', ...additionalDirectories)
    if (strictMcpConfig) args.push('--strict-mcp-config')
    if (permissionMode) args.push('--permission-mode', permissionMode)

    if (fallbackModel) {
        if (model && fallbackModel === model) {
            throw new Error('Fallback model cannot be the same as the main model. Please specify a different model for fallbackModel option.')
        }
        args.push('--fallback-model', fallbackModel)
    }

    // Handle prompt input
    if (typeof prompt === 'string') {
        args.push('--print', stripNewlinesForWindowsShellArg(prompt.trim()))
    } else {
        args.push('--input-format', 'stream-json')
    }

    // Determine how to spawn Claude Code
    // - If it's just 'claude' command → spawn('claude', args) with shell on Windows
    // - If it's a full path to binary or script → spawn(path, args)
    const isCommandOnly = pathToClaudeCodeExecutable === 'claude'
    
    // Validate executable path (skip for command-only mode)
    if (!isCommandOnly && !existsSync(pathToClaudeCodeExecutable)) {
        throw new ReferenceError(`Claude Code executable not found at ${pathToClaudeCodeExecutable}. Is options.pathToClaudeCodeExecutable set?`)
    }

    const spawnCommand = pathToClaudeCodeExecutable
    const spawnArgs = args

    cleanupMcpConfig = appendMcpConfigArg(spawnArgs, mcpServers)

    // Spawn Claude Code process
    const spawnEnv = withBunRuntimeEnv(process.env, { allowBunBeBun: false })
    logDebug(`Spawning Claude Code process: ${spawnCommand} ${spawnArgs.join(' ')}`)

    const child = spawn(spawnCommand, spawnArgs, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: config.options?.abort,
        env: spawnEnv,
        // Use shell: false with absolute path from getDefaultClaudeCodePath()
        // This avoids cmd.exe resolution issues on Windows
        shell: false,
        // Hide transient console windows on Windows when spawning Claude Code
        windowsHide: process.platform === 'win32'
    }) as ChildProcessWithoutNullStreams

    // Handle process exit
    let resolveExit: () => void
    let rejectExit: (error: Error) => void
    const processExitPromise = new Promise<void>((resolve, reject) => {
        resolveExit = resolve
        rejectExit = reject
    })

    // Handle stdin
    let childStdin: Writable | null = null
    if (typeof prompt === 'string') {
        child.stdin.end()
    } else {
        childStdin = child.stdin
    }

    // Handle stderr in debug mode
    if (process.env.DEBUG) {
        child.stderr.on('data', (data) => {
            console.error('Claude Code stderr:', data.toString())
        })
    }

    // Setup cleanup
    let cleanupPromise: Promise<void> | null = null
    const cleanup = (): Promise<void> => {
        if (cleanupPromise) {
            return cleanupPromise
        }
        cleanupPromise = (async () => {
            await killProcessByChildProcess(child)
            child.stdin.destroy()
            child.stdout.destroy()
            child.stderr.destroy()
        })()
        return cleanupPromise
    }

    const handleAbort = () => {
        void cleanup()
    }
    const handleProcessExit = () => {
        void cleanup()
    }
    config.options?.abort?.addEventListener('abort', handleAbort)
    process.on('exit', handleProcessExit)

    // Create query instance BEFORE registering close handler
    // to avoid temporal dependency on `query` variable
    const query = new Query(childStdin, child.stdout, processExitPromise, canCallTool)

    if (typeof prompt !== 'string') {
        void streamToStdin(prompt, child.stdin, config.options?.abort).catch(async (error) => {
            const err = error instanceof Error ? error : new Error(String(error))
            if (!query.registerPromptFailure(err)) {
                return
            }
            await Promise.race([
                cleanup(),
                new Promise<void>((resolve) => setTimeout(resolve, promptFailureCleanupTimeoutMs))
            ])
            query.setError(err)
            rejectExit(err)
        })
    }

    // Register close handler - query is safely defined now
    child.on('close', (code) => {
        const promptFailure = query.getPromptFailure()
        if (promptFailure) {
            rejectExit(promptFailure)
        } else if (config.options?.abort?.aborted) {
            const err = new AbortError('Claude Code process aborted by user')
            query.setError(err)
            rejectExit(err)
        } else if (code !== 0) {
            const err = new Error(`Claude Code process exited with code ${code}`)
            query.setError(err)
            rejectExit(err)
        } else {
            resolveExit()
        }
    })

    // Handle process errors
    child.on('error', (error) => {
        cleanupMcpConfig?.()
        const promptFailure = query.getPromptFailure()
        if (promptFailure) {
            rejectExit(promptFailure)
        } else if (config.options?.abort?.aborted) {
            const err = new AbortError('Claude Code process aborted by user')
            query.setError(err)
            rejectExit(err)
        } else {
            const err = new Error(`Failed to spawn Claude Code process: ${error.message}`)
            query.setError(err)
            rejectExit(err)
        }
    })

    // Cleanup on exit (catch rejection to avoid unhandled promise warning)
    processExitPromise.catch(() => {}).finally(() => {
        void cleanup()
        process.removeListener('exit', handleProcessExit)
        config.options?.abort?.removeEventListener('abort', handleAbort)
        if (process.env.CLAUDE_SDK_MCP_SERVERS) {
            delete process.env.CLAUDE_SDK_MCP_SERVERS
        }
        cleanupMcpConfig?.()
    })

    return query
}
