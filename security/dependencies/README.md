# Dependency security governance

HAPI has exactly two intentional dependency lock sources:

1. the repository-root `bun.lock`, covering all Bun workspaces; and
2. `tools/hapi-codex-sync/package-lock.json`, covering the separately executable
   npm tool that is not shipped inside the HAPI CLI.

Any additional Bun, npm, pnpm, or Yarn lockfile is an error. The same graph,
audit, policy, and SBOM code is used locally, in CI, for Web deployment, and for
tag releases.

## Operator workflow

1. Generate an inventory below `.hapi-work` with
   `bun run dependency:inventory -- --out <new-directory> --as-of YYYY-MM-DD`
   plus all four immutable baseline lock/audit flags.
2. Inspect `advisory-matrix.candidate.json`, the normalized baseline/current
   instance files, metadata, raw audit receipts, and every dependency-path diff.
3. Manually review every entry. Inventory is candidate-only: it refuses the
   checked-in `security/dependencies/advisory-matrix.json` path and never
   overwrites that policy.
4. Copy the reviewed candidate to the policy path only after filling every
   owner, rationale, evidence item, disposition, target or expiry, and override
   record. Review the Git diff before committing.
5. Run `bun run dependency:security -- --out <new-directory> --as-of
   YYYY-MM-DD`. Both exit `1` policy failures and exit `2` operational failures
   block changes.
6. After a clean policy commit, run `bun run dependency:sbom -- --out
   <new-directory> --git-sha <full-40-hex-HEAD>` twice and compare the outputs.

Never use wildcard ignores, blanket advisory suppression, or generated prose as
evidence. A new advisory, unknown instance, stale lock hash, changed severity or
path, fixed reappearance, expired exception, malformed audit, or extra lockfile
fails closed.

## Decision rules

- Runtime-reachable critical and high findings must be zero. They cannot be
  accepted as risk.
- Every fixed entry requires owner, concrete rationale, exact fixed target, and
  file plus command/test verification evidence.
- Every accepted risk requires owner, concrete reachability rationale, source
  and command/test evidence, review date, and expiry. Critical/high non-runtime
  exceptions last at most 30 days; moderate/low exceptions last at most 90
  days.
- A classification below the computed role requires specific source and
  command/test evidence proving that the graph edge is not executable.
- There are no wildcard ignores.

## Overrides

There are no blanket overrides. Each exact manifest override must have one
matching policy record naming the selected package/version, blocked
parent/range, owner, rationale, compatibility tests, review date, and removal
date. Overrides expire after at most 30 days. An unregistered manifest override,
version drift, stale policy record, missing compatibility evidence, or expired
removal date is a policy failure.

## Exit contract and evidence

- `0`: every lock, advisory instance, decision, exception, and override passes;
- `1`: a security or policy violation;
- `2`: an audit, parser, lock, Git identity, or output-write failure.

Fresh audits preserve stdout, stderr, and status byte-for-byte. Explicit audit
mode copies only the supplied JSON and records its hash/source. Output
directories must be new or empty so evidence from separate runs cannot mix.
Logs and summaries must never contain environment variables, registry
configuration, credentials, request headers, or tokens.

## SBOM scope

`hapi.cdx.json` is the CycloneDX 1.6 `shipped` graph for the canonical Bun
workspaces. `hapi-codex-sync.cdx.json` is explicitly
`not-shipped-with-cli`. Both are validated offline against the reviewed vendored
schemas in `schemas/`, and their hashes, lock hashes, policy hash, schema hashes,
component/edge counts, package-manager versions, and explicit Git SHA are bound
by `hapi-sbom-manifest.json`.
