import type { DefaultEventsMap, Server, Socket } from 'socket.io'

export type SocketData = {
    namespace?: string
    userId?: number
}

export type SocketServer = Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>
export type SocketWithData = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>
