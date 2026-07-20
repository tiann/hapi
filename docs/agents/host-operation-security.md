# Host operation security

Use this checklist for changes that let a remote client read or mutate host files,
manage repositories, or pass values to a subprocess. These changes cross the trust
boundary between the hub and a runner machine.

## Threat model

- Treat every RPC field as untrusted, including authenticated requests.
- Assume workspace contents can change concurrently between validation and use.
- Assume symlinks can point outside the workspace or be retargeted.
- Treat Git metadata, local repository paths, command arguments, and file contents
  as sensitive host resources.

## Required invariants

1. **Workspace containment applies to every filesystem operand.** Validate sources,
   destinations, local clone sources, local remote URLs, and paths derived during
   recursion. Canonicalize paths through the workspace scope instead of relying on
   lexical prefix checks.
2. **Validation remains valid at use time.** A path checked during `prepare` is not
   safe to reopen later without protection. Keep an already-validated file handle
   where possible; otherwise revalidate immediately before use and avoid an async
   gap that allows retargeting.
3. **The file plane cannot expose Git metadata.** Reject `.git` as a case-insensitive
   path segment for list, preview, read, write, copy, move, delete, and download.
   Recursive operations and archives must inspect nested entries before mutation or
   disclosure. Git metadata is managed only through structured Git operations.
4. **Recursive and batch mutations are preflighted.** Validate the full source and
   destination set before changing anything. Reject overlapping paths and preserve
   all-or-nothing behavior when validation fails.
5. **Every ingress path has a resource bound.** Apply size and count limits in the
   shared runtime schema, including generic operation endpoints. For text, enforce
   the documented UTF-8 byte limit rather than only JavaScript string length.
6. **Subprocess arguments preserve command semantics.** Use argument arrays, never
   shell strings. Reject option-like identifiers such as leading-dash remote names,
   or use `--` only where the command supports it. Validate branch and remote names
   against their domain rules, while keeping common valid forms covered by tests.
7. **Local Git inputs are filesystem inputs.** Scope absolute paths, relative paths,
   and `file:` URLs used by clone or remote operations. Network remotes must reject
   inline credentials.
8. **Long-lived operations stay bound to the validated resource.** Downloads,
   uploads, and queued jobs must fail cleanly when the resource changes. They must
   not loop forever, cross the workspace boundary, or silently switch targets.

## Operation matrix

For every new or changed operation, identify all applicable checks before coding.

| Operation | Mandatory checks |
| --- | --- |
| List / preview / read | containment, `.git`, symlink target, output bound |
| Create / write / upload | parent containment, `.git`, payload bound, conflict policy |
| Copy / move / delete | every source and destination, nested `.git`, overlap, full preflight |
| Prepare / read download | containment, nested `.git`, stable handle, truncation/change behavior |
| Clone / set remote | destination and local-source scope, URL credentials, option semantics |
| Git branch / remote action | domain-valid name, option injection, valid common names |

Do not mark a row covered because another operation uses the same UI. Trace each RPC
schema through the manager to its filesystem or subprocess sink.

## Required tests

Add the smallest tests that cover the changed invariant at both relevant boundaries:

- shared schema tests for malformed payloads, byte limits, and command identifiers;
- manager tests for containment, filesystem races, recursion, and command behavior;
- one valid control case for every restrictive validator;
- adversarial cases for absolute and relative escapes, symlinks, `.git` direct and
  nested paths, leading-dash arguments, multi-byte payloads, and changed resources;
- no-partial-mutation assertions for rejected batch or recursive operations.

Tests for a reported bug must cover the bug class, not only the exact example from
the review comment. After a finding, search sibling operations for the same missing
invariant before pushing the fix.

## Pre-push review

1. Inventory changed RPC entry points and filesystem/subprocess sinks.
2. Complete the operation matrix for the changed behavior.
3. Review `git diff origin/main...HEAD`, not only the latest fix commit.
4. Run focused adversarial tests, then `bun typecheck && bun run test`.
5. Apply `.github/prompts/codex-pr-review.md` and verify every finding was generalized
   to adjacent operations before pushing.
