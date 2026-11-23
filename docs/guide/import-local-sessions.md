---
description: "Import Antigravity, Claude Code, Codex, OpenCode and Pi conversations started outside HAPI and continue them from the web app."
---

# Import local sessions

Conversations you had with an agent **outside** HAPI — in a plain terminal, before you installed HAPI, or on another tool that shares the agent's history — can be imported into HAPI and continued from the web app.

Importing copies the native transcript into the hub as a HAPI session on the machine that owns it. The original history on disk is not modified.

## Supported agents

| Agent | Reads history from | Imported session lands as |
|-------|--------------------|---------------------------|
| Antigravity | `~/.gemini/antigravity-cli/` (`conversation_summaries.db` and `brain/<id>/.system_generated/logs/`, or `$AGY_APP_DATA_DIR`) | Archived |
| Claude Code | `~/.claude/projects/` (or `$CLAUDE_CONFIG_DIR/projects/`), including subagent transcripts | Archived |
| Codex | `~/.codex/sessions/` (or `$CODEX_HOME/sessions/`) | Imported |
| OpenCode | `opencode.db` under `~/.local/share/opencode` (or `$OPENCODE_HOME`, `$XDG_DATA_HOME/opencode`) | Archived |
| Pi | `~/.pi/agent/sessions/` (or `$PI_CODING_AGENT_DIR/sessions`, `$PI_CODING_AGENT_SESSION_DIR`) | Archived |

All five go through one import pipeline on the hub, so they behave the same way: same machine selection, same duplicate handling, same limits. Other agents do not support history import.

## Importing from the web app

1. Open **New session** and pick the machine and agent (Antigravity, Claude, Codex, OpenCode or Pi).
2. Below the agent picker, find **Import \<agent\> history** and choose **Choose history**.
3. The dialog lists the most recent local sessions on that machine, newest first. Filter by working directory or search by title, prompt, path or ID. Sessions already in HAPI are marked **Imported** (for Codex, this badge is remembered by the browser that imported them).
4. Select one or more sessions:
   - **One selection** becomes the session to continue: press **Import** and the dialog closes with that session selected in the form. Adjust model / effort / permission mode, then create the session. HAPI imports the transcript, applies your settings, and opens the session ready for the next message.
   - **Several selections** are imported right away when you press **Import**, without opening any of them. A toast reports how many succeeded, and the sessions appear in the session list.

::: warning Close other copies first
Several processes can open the same native session. Before continuing an imported session in HAPI, close or reload any other Antigravity / Claude / Codex / OpenCode / Pi process that has it open, so the two do not write diverging histories.
:::

The iOS and Android apps do not have an import picker. Sessions imported from the web appear in their session lists like any other.

## Machine selection

Native history lives on one machine, so the import runs on that machine's runner:

1. The machine selected in the New session form, if it is online
2. Otherwise, the one online machine whose workspace roots contain the requested directory
3. Otherwise, the first online machine

If no machine is online the import fails with *No online machine available*. Codex, OpenCode and Pi import also work with older runners through their previous per-agent path; Antigravity and Claude imports need a current runner, and an older one reports *\<Agent\> runner does not support local history import* — upgrade HAPI on that machine and restart the runner.

## Importing again (deduplication)

Importing the same native session again does not create a duplicate. HAPI finds the session it already created (by the native session ID, including Claude's rotated IDs after a resume) and appends only the messages that are new since the last import. The result is one of:

| Result | Meaning |
|--------|---------|
| Created | First import; a new HAPI session |
| Updated | New native messages were appended |
| Unchanged | Nothing new to add |

Messages you sent from HAPI after the import stay in place — re-importing merges, it never replaces. A HAPI rename of the session is also preserved.

For Antigravity, after continuing in HAPI, a re-import appends new native messages only when the stored conversation matches the native history in order. If the histories conflict, HAPI reports divergence and keeps the existing conversation.

An import is refused when:

- **The HAPI session is active** and the native history has new messages. Stop the HAPI session first; HAPI never interleaves imported messages into a live session.
- **The native history diverged** from what was imported (for example, it was rewound or edited elsewhere). Review the session before continuing; Pi marks such sessions **Needs attention**.
- **The session already lives in HAPI.** A conversation that was started in HAPI has nothing to import.

Concurrent imports of the same native session run one after another, so the second sees nothing new.

In the session list, sessions from these five agents are de-duplicated per machine: the same native ID on two different machines shows as two sessions.

## Limits

- The picker lists at most the **200** most recent sessions per agent on a machine.
- One import request accepts at most **200** sessions; more is rejected.
- For Codex, a batch stops at the first failed session. For Antigravity, Claude, OpenCode and Pi, failures are reported per session and the rest continue.
- Token usage recorded in imported transcripts is not counted in the [token usage dashboard](./usage-and-quotas.md#token-usage-dashboard).

## Codex: import vs. shared sessions

Import copies Codex history from disk into a new HAPI session. To share one live Codex execution between the official terminal UI and HAPI clients, use a shared session instead (`hapi codex`, `hapi resume`, `hapi codex resume`). See [Codex shared sessions](./codex-shared-sessions.md).

## Related

- [Supported agents](./agents.md)
- [Session list](./session-list.md)
- [Codex shared sessions](./codex-shared-sessions.md)
