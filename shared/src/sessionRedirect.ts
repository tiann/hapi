/**
 * Opt-in request header for `/api` session routes: when set to `'1'`, a
 * merged-away session id resolves to the surviving session (the response then
 * carries the survivor's id and the client must rebind to it). Clients that do
 * not rebind (they would keep live state under the old id) omit it and get the
 * plain 404 for a merged-away id. CLI REST routes always follow redirects.
 */
export const FOLLOW_SESSION_REDIRECTS_HEADER = 'x-hapi-follow-session-redirects'
