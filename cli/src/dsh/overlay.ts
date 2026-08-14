import { DSH_RUNTIME_VERSION } from './types'

/**
 * Official `dsh --profile web` patch overlay that strips the entire web
 * surface, leaving a host-only DeepSeek Harness runtime:
 *
 * - `web-runtime` disabled → no `dsh web:` URL line, no model GUI-context
 *   prompt section, no frontend dist serving (verified: GET / → 404).
 * - `connection` keeps the `/api` transport but loses its `webRuntime`
 *   dependency (`inject: []`) and trusts nobody (`trustedHosts: []`).
 * - The browser-plugin roster rows (`modules`, `client-hmr`, `locale`,
 *   `ui-theme`, `api-remotes`, `client-runtime`, `cordis-client-runner`) are
 *   node-side no-ops but disabling them keeps the composition minimal.
 *
 * The overlay is validated against every pinned DSH_RUNTIME_VERSION in the
 * integration test (`DshRuntime.test.ts` boots a real host when available and
 * asserts GET / is not served while /api works).
 */
export const DSH_HOST_ONLY_OVERLAY = `
- id: web-runtime
  disabled: true
- id: connection
  inject: []
  config:
    trustedHosts: []
- id: modules
  disabled: true
- id: client-hmr
  disabled: true
- id: locale
  disabled: true
- id: ui-theme
  disabled: true
- id: api-remotes
  disabled: true
- id: client-runtime
  disabled: true
- id: cordis-client-runner
  disabled: true
`.trim()

/** npm package spec pinned to the exact DSH release this build supports. */
export const DSH_RUNTIME_PACKAGE = `@deepseek-ai/dsh@${DSH_RUNTIME_VERSION}` as const
