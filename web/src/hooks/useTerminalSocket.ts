import { useCallback, useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'

type TerminalConnectionState =
    | { status: 'idle' }
    | { status: 'connecting' }
    | { status: 'connected' }
    | { status: 'error'; error: string }

type UseTerminalSocketOptions = {
    baseUrl: string
    token: string
    sessionId: string
    terminalId: string
}

type TerminalReadyPayload = {
    terminalId: string
}

type TerminalOutputPayload = {
    terminalId: string
    data: string
}

type TerminalExitPayload = {
    terminalId: string
    code: number | null
    signal: string | null
}

type TerminalErrorPayload = {
    terminalId: string
    message: string
}

export function useTerminalSocket(options: UseTerminalSocketOptions): {
    state: TerminalConnectionState
    connect: (cols: number, rows: number) => void
    write: (data: string) => void
    resize: (cols: number, rows: number) => void
    disconnect: () => void
    onOutput: (handler: (data: string) => void) => void
    onExit: (handler: (code: number | null, signal: string | null) => void) => void
} {
    const [state, setState] = useState<TerminalConnectionState>({ status: 'idle' })
    const socketRef = useRef<Socket | null>(null)
    const outputHandlerRef = useRef<(data: string) => void>(() => {})
    const exitHandlerRef = useRef<(code: number | null, signal: string | null) => void>(() => {})
    const sessionIdRef = useRef(options.sessionId)
    const terminalIdRef = useRef(options.terminalId)
    const tokenRef = useRef(options.token)
    const baseUrlRef = useRef(options.baseUrl)
    const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null)

    useEffect(() => {
        sessionIdRef.current = options.sessionId
        terminalIdRef.current = options.terminalId
        baseUrlRef.current = options.baseUrl
    }, [options.sessionId, options.terminalId, options.baseUrl])

    useEffect(() => {
        tokenRef.current = options.token
        const socket = socketRef.current
        if (!socket) {
            return
        }
        if (!options.token) {
            console.error('[Terminal] stage=auth.update outcome=error', {
                cause: 'missing_token',
                sessionId: sessionIdRef.current,
                terminalId: terminalIdRef.current
            })
            if (socket.connected) {
                socket.disconnect()
            }
            return
        }
        socket.auth = { token: options.token }
        if (socket.connected) {
            console.log('[Terminal] stage=socket.reconnect outcome=retry', {
                cause: 'token_changed',
                sessionId: sessionIdRef.current,
                terminalId: terminalIdRef.current
            })
            socket.disconnect()
            socket.connect()
        }
    }, [options.token])

    const logTerminalEvent = useCallback((
        level: 'log' | 'error',
        stage: string,
        outcome: 'start' | 'success' | 'error' | 'duplicate' | 'retry',
        details: Record<string, unknown>
    ) => {
        const message = `[Terminal] stage=${stage} outcome=${outcome}`
        if (level === 'error') {
            console.error(message, details)
            return
        }
        console.log(message, details)
    }, [])

    const isCurrentTerminal = useCallback((terminalId: string) => terminalId === terminalIdRef.current, [])

    const emitCreate = useCallback((socket: Socket, size: { cols: number; rows: number }) => {
        logTerminalEvent('log', 'terminal.create.emit', 'start', {
            sessionId: sessionIdRef.current,
            terminalId: terminalIdRef.current,
            cols: size.cols,
            rows: size.rows
        })
        socket.emit('terminal:create', {
            sessionId: sessionIdRef.current,
            terminalId: terminalIdRef.current,
            cols: size.cols,
            rows: size.rows
        })
    }, [logTerminalEvent])

    const setErrorState = useCallback((message: string, cause?: string) => {
        if (cause) {
            logTerminalEvent('error', 'terminal.state', 'error', {
                sessionId: sessionIdRef.current,
                terminalId: terminalIdRef.current,
                cause,
                message
            })
        }
        setState({ status: 'error', error: message })
    }, [logTerminalEvent])

    const connect = useCallback((cols: number, rows: number) => {
        lastSizeRef.current = { cols, rows }
        const token = tokenRef.current
        const sessionId = sessionIdRef.current
        const terminalId = terminalIdRef.current

        logTerminalEvent('log', 'terminal.connect', 'start', {
            sessionId,
            terminalId,
            cols,
            rows,
            hasExistingSocket: socketRef.current !== null
        })

        if (!token || !sessionId || !terminalId) {
            setErrorState('Missing terminal credentials.', 'missing_terminal_credentials')
            return
        }

        if (socketRef.current) {
            const socket = socketRef.current
            socket.auth = { token }
            if (socket.connected) {
                logTerminalEvent('log', 'terminal.connect', 'duplicate', {
                    sessionId,
                    terminalId,
                    cause: 'socket_already_connected'
                })
                emitCreate(socket, { cols, rows })
            } else {
                logTerminalEvent('log', 'terminal.socket.connect', 'retry', {
                    sessionId,
                    terminalId,
                    cause: 'reuse_existing_socket'
                })
                socket.connect()
            }
            setState({ status: 'connecting' })
            return
        }

        const socket = io(`${baseUrlRef.current}/terminal`, {
            auth: { token },
            path: '/socket.io/',
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            transports: ['polling', 'websocket'],
            autoConnect: false
        })

        socketRef.current = socket
        setState({ status: 'connecting' })

        socket.on('connect', () => {
            const size = lastSizeRef.current ?? { cols, rows }
            logTerminalEvent('log', 'terminal.socket.connect', 'success', {
                sessionId: sessionIdRef.current,
                terminalId: terminalIdRef.current,
                socketId: socket.id ?? null,
                cols: size.cols,
                rows: size.rows
            })
            setState({ status: 'connecting' })
            emitCreate(socket, size)
        })

        socket.on('terminal:ready', (payload: TerminalReadyPayload) => {
            if (!isCurrentTerminal(payload.terminalId)) {
                return
            }
            logTerminalEvent('log', 'terminal.ready', 'success', {
                sessionId: sessionIdRef.current,
                terminalId: payload.terminalId
            })
            setState({ status: 'connected' })
        })

        socket.on('terminal:output', (payload: TerminalOutputPayload) => {
            if (!isCurrentTerminal(payload.terminalId)) {
                return
            }
            outputHandlerRef.current(payload.data)
        })

        socket.on('terminal:exit', (payload: TerminalExitPayload) => {
            if (!isCurrentTerminal(payload.terminalId)) {
                return
            }
            logTerminalEvent('error', 'terminal.exit', 'error', {
                sessionId: sessionIdRef.current,
                terminalId: payload.terminalId,
                code: payload.code,
                signal: payload.signal,
                cause: 'terminal_process_exit'
            })
            exitHandlerRef.current(payload.code, payload.signal)
            setErrorState('Terminal exited.', 'terminal_exited')
        })

        socket.on('terminal:error', (payload: TerminalErrorPayload) => {
            if (!isCurrentTerminal(payload.terminalId)) {
                return
            }
            logTerminalEvent('error', 'terminal.error', 'error', {
                sessionId: sessionIdRef.current,
                terminalId: payload.terminalId,
                message: payload.message,
                cause: 'terminal_runtime_error'
            })
            setErrorState(payload.message)
        })

        socket.on('connect_error', (error) => {
            const message = error instanceof Error ? error.message : 'Connection error'
            logTerminalEvent('error', 'terminal.socket.connect', 'error', {
                sessionId: sessionIdRef.current,
                terminalId: terminalIdRef.current,
                cause: 'connect_error',
                message
            })
            setErrorState(message)
        })

        socket.on('disconnect', (reason) => {
            if (reason === 'io client disconnect') {
                logTerminalEvent('log', 'terminal.socket.disconnect', 'success', {
                    sessionId: sessionIdRef.current,
                    terminalId: terminalIdRef.current,
                    reason
                })
                setState({ status: 'idle' })
                return
            }
            logTerminalEvent('error', 'terminal.socket.disconnect', 'error', {
                sessionId: sessionIdRef.current,
                terminalId: terminalIdRef.current,
                reason,
                cause: 'unexpected_disconnect'
            })
            setErrorState(`Disconnected: ${reason}`)
        })

        socket.connect()
    }, [emitCreate, setErrorState, isCurrentTerminal, logTerminalEvent])

    const write = useCallback((data: string) => {
        const socket = socketRef.current
        if (!socket || !socket.connected) {
            logTerminalEvent('error', 'terminal.write', 'error', {
                sessionId: sessionIdRef.current,
                terminalId: terminalIdRef.current,
                cause: 'socket_not_connected'
            })
            return
        }
        socket.emit('terminal:write', { terminalId: terminalIdRef.current, data })
    }, [logTerminalEvent])

    const resize = useCallback((cols: number, rows: number) => {
        lastSizeRef.current = { cols, rows }
        const socket = socketRef.current
        if (!socket || !socket.connected) {
            logTerminalEvent('error', 'terminal.resize', 'error', {
                sessionId: sessionIdRef.current,
                terminalId: terminalIdRef.current,
                cols,
                rows,
                cause: 'socket_not_connected'
            })
            return
        }
        socket.emit('terminal:resize', { terminalId: terminalIdRef.current, cols, rows })
    }, [logTerminalEvent])

    const disconnect = useCallback(() => {
        const socket = socketRef.current
        if (!socket) {
            return
        }
        logTerminalEvent('log', 'terminal.disconnect', 'success', {
            sessionId: sessionIdRef.current,
            terminalId: terminalIdRef.current
        })
        socket.removeAllListeners()
        socket.disconnect()
        socketRef.current = null
        setState({ status: 'idle' })
    }, [logTerminalEvent])

    const onOutput = useCallback((handler: (data: string) => void) => {
        outputHandlerRef.current = handler
    }, [])

    const onExit = useCallback((handler: (code: number | null, signal: string | null) => void) => {
        exitHandlerRef.current = handler
    }, [])

    return {
        state,
        connect,
        write,
        resize,
        disconnect,
        onOutput,
        onExit
    }
}
