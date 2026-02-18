import { useCallback, useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'

type TerminalConnectionState =
    | { status: 'idle' }
    | { status: 'connecting' }
    | { status: 'reconnecting' }
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

const MAX_CONNECT_ERRORS_BEFORE_FAILURE = 5
const TERMINAL_DEBUG_STORAGE_KEY = 'hapi:debug:terminal'

function isTerminalDebugEnabled(): boolean {
    if (typeof window === 'undefined') {
        return false
    }
    if (import.meta.env.DEV) {
        return true
    }
    try {
        return window.localStorage.getItem(TERMINAL_DEBUG_STORAGE_KEY) === '1'
    } catch {
        return false
    }
}

function describeSequence(sequence: string): string {
    if (!sequence) {
        return '(empty)'
    }
    return sequence
        .split('')
        .map((char) => {
            const code = char.charCodeAt(0)
            if (char === '\u0008') return 'BS(0x08)'
            if (char === '\u007f') return 'DEL(0x7f)'
            if (char === '\r') return 'CR(0x0d)'
            if (char === '\n') return 'LF(0x0a)'
            if (char === '\t') return 'TAB(0x09)'
            if (code < 32 || code === 127) {
                return `CTRL(0x${code.toString(16).padStart(2, '0')})`
            }
            return `${char}(0x${code.toString(16).padStart(2, '0')})`
        })
        .join(' ')
}

function debugTerminal(label: string, data: Record<string, unknown>): void {
    if (!isTerminalDebugEnabled()) {
        return
    }
    console.debug(`[TerminalDebug] ${label}`, data)
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
    const connectErrorCountRef = useRef(0)

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
            if (socket.connected) {
                socket.disconnect()
            }
            return
        }
        socket.auth = { token: options.token }
        if (socket.connected) {
            socket.disconnect()
            socket.connect()
        }
    }, [options.token])

    const isCurrentTerminal = useCallback((terminalId: string) => terminalId === terminalIdRef.current, [])

    const emitCreate = useCallback((socket: Socket, size: { cols: number; rows: number }) => {
        socket.emit('terminal:create', {
            sessionId: sessionIdRef.current,
            terminalId: terminalIdRef.current,
            cols: size.cols,
            rows: size.rows
        })
    }, [])

    const setErrorState = useCallback((message: string) => {
        setState({ status: 'error', error: message })
    }, [])

    const setReconnectingState = useCallback(() => {
        setState((current) => {
            if (current.status === 'idle') {
                return current
            }
            return { status: 'reconnecting' }
        })
    }, [])

    const connect = useCallback((cols: number, rows: number) => {
        lastSizeRef.current = { cols, rows }
        const token = tokenRef.current
        const sessionId = sessionIdRef.current
        const terminalId = terminalIdRef.current

        if (!token || !sessionId || !terminalId) {
            setErrorState('Missing terminal credentials.')
            return
        }

        if (socketRef.current) {
            const socket = socketRef.current
            socket.auth = { token }
            if (socket.connected) {
                connectErrorCountRef.current = 0
                emitCreate(socket, { cols, rows })
            } else {
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
            connectErrorCountRef.current = 0
            setState({ status: 'connecting' })
            emitCreate(socket, size)
        })

        socket.on('terminal:ready', (payload: TerminalReadyPayload) => {
            if (!isCurrentTerminal(payload.terminalId)) {
                return
            }
            connectErrorCountRef.current = 0
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
            exitHandlerRef.current(payload.code, payload.signal)
            setState({ status: 'idle' })
        })

        socket.on('terminal:error', (payload: TerminalErrorPayload) => {
            if (!isCurrentTerminal(payload.terminalId)) {
                return
            }
            setErrorState(payload.message)
        })

        socket.on('connect_error', (error) => {
            const message = error instanceof Error ? error.message : 'Connection error'
            connectErrorCountRef.current += 1
            if (connectErrorCountRef.current >= MAX_CONNECT_ERRORS_BEFORE_FAILURE) {
                setErrorState(message)
                return
            }
            setReconnectingState()
        })

        socket.on('disconnect', (reason) => {
            if (reason === 'io client disconnect') {
                setState({ status: 'idle' })
                return
            }
            setReconnectingState()
            if (reason === 'io server disconnect') {
                socket.connect()
            }
        })

        socket.connect()
    }, [emitCreate, setErrorState, setReconnectingState, isCurrentTerminal])

    const write = useCallback((data: string) => {
        const socket = socketRef.current
        if (!socket || !socket.connected) {
            debugTerminal('socket.write skipped (not connected)', {
                data: describeSequence(data),
                terminalId: terminalIdRef.current
            })
            return
        }
        debugTerminal('socket.write', {
            terminalId: terminalIdRef.current,
            data: describeSequence(data)
        })
        socket.emit('terminal:write', { terminalId: terminalIdRef.current, data })
    }, [])

    const resize = useCallback((cols: number, rows: number) => {
        lastSizeRef.current = { cols, rows }
        const socket = socketRef.current
        if (!socket || !socket.connected) {
            return
        }
        socket.emit('terminal:resize', { terminalId: terminalIdRef.current, cols, rows })
    }, [])

    const disconnect = useCallback(() => {
        const socket = socketRef.current
        if (!socket) {
            return
        }
        socket.removeAllListeners()
        socket.disconnect()
        socketRef.current = null
        connectErrorCountRef.current = 0
        setState({ status: 'idle' })
    }, [])

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
