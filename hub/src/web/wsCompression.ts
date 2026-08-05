/**
 * WebSocket per-message-deflate defaults.
 *
 * Bun negotiates the permessage-deflate extension when `perMessageDeflate:
 * true` is set on the serve options, but actually compressing a frame is
 * still opt-in per send() call — and @socket.io/bun-engine (plus the voice
 * proxies) call `ws.send(data)` without the flag, so nothing would ever be
 * compressed. Wrapping send() turns the negotiated extension into actual
 * wire compression: terminal streams and CLI sync JSON shrink by 70-99%
 * through the relay tunnel.
 *
 * Safe for every client: when the peer did not negotiate the extension Bun
 * ignores the compress flag and sends plaintext (verified: RSV1 stays 0 and
 * the payload arrives intact). Callers that pass an explicit flag keep it.
 */

type CompressibleSend = (
    data: string | Bun.BufferSource,
    compress?: boolean
) => number

export function applyDefaultWsCompression(ws: { send: CompressibleSend }): void {
    const original = ws.send.bind(ws)
    ws.send = (data, compress) => original(data, compress ?? true)
}
