/**
 * Loopback proxy bypass.
 *
 * The CLI talks to itself and to local agents over loopback HTTP (hook
 * forwarder -> hook server, control client -> runner, claude -> local MCP
 * server). Runtime fetch and other HTTP clients honor HTTP_PROXY/HTTPS_PROXY,
 * so when the user's shell exports a proxy without excluding localhost in
 * NO_PROXY, every loopback request can be routed through the proxy - which may
 * forward "127.0.0.1" to a remote node where nothing is listening. Symptom:
 * SessionStart hooks never arrive, transcripts never sync, web UI stays empty.
 *
 * Fix: make sure NO_PROXY always covers loopback. Children (claude, runner,
 * hook-forwarder) inherit the patched env, so their loopback traffic is covered
 * too. Non-loopback traffic keeps using the configured proxy.
 *
 * The implementation lives in @hapi/protocol/net so the hub shares the same
 * resolver; this module keeps the existing CLI import path.
 */

export { ensureLoopbackProxyBypass } from '@hapi/protocol/net';
