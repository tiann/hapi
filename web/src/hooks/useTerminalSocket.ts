import { useCallback, useEffect, useRef, useState } from 'react'
import { Manager, type Socket } from 'socket.io-client'

type TerminalConnectionState =
    | { status: 'idle' }
    | { status: 'connecting' }
    | { status: 'connected' }
    | { status: 'error'; error: string }

export type RemoteTerminalSession = {
    terminalId: string
    createdAt: number
    attached: boolean
}

type UseTerminalSocketOptions = {
    baseUrl: string
    token: string
    sessionId: string
    terminalId: string | null
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

type TerminalSessionsPayload = {
    sessionId: string
    maxTerminals: number
    terminals: RemoteTerminalSession[]
}

export function useTerminalSocket(options: UseTerminalSocketOptions): {
    state: TerminalConnectionState
    terminals: RemoteTerminalSession[]
    maxTerminals: number | null
    hasLoadedTerminals: boolean
    connect: (cols?: number, rows?: number) => void
    refreshTerminals: () => void
    createTerminal: (terminalId: string, cols: number, rows: number) => void
    detachTerminal: (terminalId: string) => void
    closeTerminal: (terminalId: string) => void
    write: (data: string) => void
    resize: (cols: number, rows: number) => void
    disconnect: () => void
    onOutput: (handler: (data: string) => void) => void
    onExit: (handler: (code: number | null, signal: string | null) => void) => void
} {
    const [state, setState] = useState<TerminalConnectionState>({ status: 'idle' })
    const [terminals, setTerminals] = useState<RemoteTerminalSession[]>([])
    const [maxTerminals, setMaxTerminals] = useState<number | null>(null)
    const [hasLoadedTerminals, setHasLoadedTerminals] = useState(false)
    const socketRef = useRef<Socket | null>(null)
    const outputHandlerRef = useRef<(data: string) => void>(() => {})
    const exitHandlerRef = useRef<(code: number | null, signal: string | null) => void>(() => {})
    const sessionIdRef = useRef(options.sessionId)
    const terminalIdRef = useRef<string | null>(options.terminalId)
    const tokenRef = useRef(options.token)
    const baseUrlRef = useRef(options.baseUrl)
    const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null)
    const pendingTerminalIdsRef = useRef(new Set<string>())

    useEffect(() => {
        const sessionChanged = sessionIdRef.current !== options.sessionId
        const terminalChanged = terminalIdRef.current !== options.terminalId
        sessionIdRef.current = options.sessionId
        terminalIdRef.current = options.terminalId
        baseUrlRef.current = options.baseUrl
        // A new xterm instance must report its own dimensions before any attach.
        if (sessionChanged || terminalChanged) {
            lastSizeRef.current = null
        }
        if (sessionChanged) {
            setTerminals([])
            setMaxTerminals(null)
            setHasLoadedTerminals(false)
            pendingTerminalIdsRef.current.clear()
        }
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

    const setErrorState = useCallback((message: string) => {
        setState({ status: 'error', error: message })
    }, [])

    const requestTerminalList = useCallback((socket: Socket) => {
        socket.emit('terminal:list', { sessionId: sessionIdRef.current })
    }, [])

    const emitAttach = useCallback((socket: Socket, terminalId: string, size: { cols: number; rows: number }) => {
        socket.emit('terminal:attach', {
            sessionId: sessionIdRef.current,
            terminalId,
            cols: size.cols,
            rows: size.rows
        })
    }, [])

    const ensureSocket = useCallback((): Socket | null => {
        const token = tokenRef.current
        const sessionId = sessionIdRef.current
        if (!token || !sessionId) {
            setErrorState('Missing terminal credentials.')
            return null
        }

        const existing = socketRef.current
        if (existing) {
            existing.auth = { token }
            if (!existing.connected) {
                setState({ status: 'connecting' })
                existing.connect()
            }
            return existing
        }

        const manager = new Manager(baseUrlRef.current, {
            path: '/socket.io/',
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            transports: ['polling', 'websocket'],
            rememberUpgrade: true,
            autoConnect: false
        })
        const socket = manager.socket('/terminal', {
            auth: { token }
        })

        socketRef.current = socket
        setState({ status: 'connecting' })

        socket.on('connect', () => {
            requestTerminalList(socket)
            const terminalId = terminalIdRef.current
            const size = lastSizeRef.current
            // Only the selected terminal's own pending create blocks attach.
            // An unselected background create must never strand an existing tab.
            if (terminalId && size && !pendingTerminalIdsRef.current.has(terminalId)) {
                setState({ status: 'connecting' })
                emitAttach(socket, terminalId, size)
            } else if (!terminalId) {
                setState({ status: 'idle' })
            }
        })

        socket.on('terminal:sessions', (payload: TerminalSessionsPayload) => {
            if (payload.sessionId !== sessionIdRef.current) {
                return
            }
            setTerminals(payload.terminals)
            setMaxTerminals(payload.maxTerminals)
            setHasLoadedTerminals(true)

            const terminalId = terminalIdRef.current
            const size = lastSizeRef.current
            if (
                terminalId
                && size
                && pendingTerminalIdsRef.current.has(terminalId)
                && payload.terminals.some((terminal) => terminal.terminalId === terminalId)
            ) {
                setState({ status: 'connecting' })
                emitAttach(socket, terminalId, size)
            }
        })

        socket.on('terminal:ready', (payload: TerminalReadyPayload) => {
            pendingTerminalIdsRef.current.delete(payload.terminalId)
            if (!isCurrentTerminal(payload.terminalId)) {
                return
            }
            setState({ status: 'connected' })
        })

        socket.on('terminal:output', (payload: TerminalOutputPayload) => {
            if (!isCurrentTerminal(payload.terminalId)) {
                return
            }
            outputHandlerRef.current(payload.data)
        })

        socket.on('terminal:exit', (payload: TerminalExitPayload) => {
            pendingTerminalIdsRef.current.delete(payload.terminalId)
            requestTerminalList(socket)
            if (!isCurrentTerminal(payload.terminalId)) {
                return
            }
            exitHandlerRef.current(payload.code, payload.signal)
            setErrorState('Terminal exited.')
        })

        socket.on('terminal:error', (payload: TerminalErrorPayload) => {
            const pending = pendingTerminalIdsRef.current.delete(payload.terminalId)
            requestTerminalList(socket)
            if (!isCurrentTerminal(payload.terminalId) && !pending) {
                return
            }
            setErrorState(payload.message)
        })

        socket.on('connect_error', (error) => {
            const message = error instanceof Error ? error.message : 'Connection error'
            setErrorState(message)
        })

        socket.on('disconnect', (reason) => {
            if (reason === 'io client disconnect') {
                setState({ status: 'idle' })
                return
            }
            setErrorState(`Disconnected: ${reason}`)
        })

        socket.connect()
        return socket
    }, [emitAttach, isCurrentTerminal, requestTerminalList, setErrorState])

    const refreshTerminals = useCallback(() => {
        const socket = ensureSocket()
        if (!socket) {
            return
        }
        if (socket.connected) {
            requestTerminalList(socket)
        }
    }, [ensureSocket, requestTerminalList])

    const connect = useCallback((cols?: number, rows?: number) => {
        if (typeof cols === 'number' && typeof rows === 'number') {
            lastSizeRef.current = { cols, rows }
        }
        const socket = ensureSocket()
        if (!socket || !socket.connected) {
            return
        }

        const terminalId = terminalIdRef.current
        const size = lastSizeRef.current
        if (!terminalId || !size) {
            requestTerminalList(socket)
            setState({ status: 'idle' })
            return
        }

        if (pendingTerminalIdsRef.current.has(terminalId)) {
            requestTerminalList(socket)
            setState({ status: 'connecting' })
            return
        }

        setState({ status: 'connecting' })
        emitAttach(socket, terminalId, size)
    }, [emitAttach, ensureSocket, requestTerminalList])

    const createTerminal = useCallback((terminalId: string, cols: number, rows: number) => {
        // Record the intended resource synchronously before reconnect can fire.
        // Manual New invokes create before React commits activeTerminalId, so
        // this prevents the generic connect handler from reattaching the stale
        // previous tab. The new xterm must still report its own size afterward.
        pendingTerminalIdsRef.current.add(terminalId)
        terminalIdRef.current = terminalId
        lastSizeRef.current = null
        const socket = ensureSocket()
        if (!socket) {
            pendingTerminalIdsRef.current.delete(terminalId)
            return
        }
        setState({ status: 'connecting' })
        const emit = () => {
            socket.emit('terminal:create', {
                sessionId: sessionIdRef.current,
                terminalId,
                cols,
                rows,
                // Resource creation and viewer attachment are separate lifecycles.
                // Waiting for authoritative inventory before the first attach lets
                // the hub replay any startup bytes that arrived in the meantime.
                attach: false
            })
        }
        if (socket.connected) {
            emit()
        } else {
            socket.once('connect', emit)
        }
    }, [ensureSocket])

    const detachTerminal = useCallback((terminalId: string) => {
        const socket = socketRef.current
        if (!socket || !socket.connected) {
            return
        }
        socket.emit('terminal:detach', {
            sessionId: sessionIdRef.current,
            terminalId
        })
    }, [])

    const closeTerminal = useCallback((terminalId: string) => {
        const socket = ensureSocket()
        if (!socket) {
            return
        }
        const emit = () => {
            socket.emit('terminal:close', {
                sessionId: sessionIdRef.current,
                terminalId
            })
        }
        if (socket.connected) {
            emit()
        } else {
            socket.once('connect', emit)
        }
    }, [ensureSocket])

    const write = useCallback((data: string) => {
        const socket = socketRef.current
        const terminalId = terminalIdRef.current
        if (!socket || !socket.connected || !terminalId) {
            return
        }
        socket.emit('terminal:write', { terminalId, data })
    }, [])

    const resize = useCallback((cols: number, rows: number) => {
        lastSizeRef.current = { cols, rows }
        const socket = socketRef.current
        const terminalId = terminalIdRef.current
        if (!socket || !socket.connected || !terminalId) {
            return
        }
        if (pendingTerminalIdsRef.current.has(terminalId)) {
            requestTerminalList(socket)
            return
        }
        socket.emit('terminal:resize', { terminalId, cols, rows })
    }, [requestTerminalList])

    const disconnect = useCallback(() => {
        const socket = socketRef.current
        if (!socket) {
            return
        }
        socket.removeAllListeners()
        socket.disconnect()
        socketRef.current = null
        pendingTerminalIdsRef.current.clear()
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
        terminals,
        maxTerminals,
        hasLoadedTerminals,
        connect,
        refreshTerminals,
        createTerminal,
        detachTerminal,
        closeTerminal,
        write,
        resize,
        disconnect,
        onOutput,
        onExit
    }
}
