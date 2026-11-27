---
description: "Fork, rewind, branch across harnesses and export HAPI conversations, with per-agent support for Claude Code, Codex, OpenCode, Grok, Cursor and Pi."
---

# Fork, rewind, branch and export

HAPI gives you four ways to work with a conversation's history:

| Action | What it does | Source session |
|--------|--------------|----------------|
| **Fork** | Creates a new session that continues from a point in the agent's own (native) history | Unchanged |
| **Rewind** | Removes history from a user message onward, in place | Shortened permanently |
| **Branch with options** | Starts a fresh Claude Code or Codex session that gets the visible conversation text as reference, with a harness, model and workspace you choose | Unchanged |
| **Export** | Downloads the conversation as JSON or Markdown | Unchanged |

None of these touch your files. A fork or rewind changes only the conversation; your working tree stays as it is. To get a clean copy of the code, branch into a Git worktree (see [Branch with options](#branch-with-options)).

## Which agents support what

Fork and rewind use each agent's own history API, so support depends on the agent. HAPI shows a control only after the agent reports that it supports it. If you don't see a button, the session doesn't support that action.

| Agent | Fork latest turn | Fork at a message | Rewind | Fork from session list | Branch from this session |
|-------|------------------|-------------------|--------|------------------------|--------------------------|
| Claude | Yes | — | — | — | Yes |
| Codex | Yes | Yes, also while a turn is running | — | Yes (active and archived) | Yes |
| Grok Build | Yes¹ | Yes¹ | Yes¹ | — | — |
| OpenCode | v2 only¹ | v2 only¹ | v2 only¹ | — | — |
| Pi | Yes¹ | Yes¹ | Yes¹ | — | — |
| Cursor Agent | Verified ACP store¹ | Recorded checkpoints¹ | Recorded checkpoints¹ | — | — |
| Gemini, Kimi, Copilot, Antigravity, DeepSeek Harness | — | — | — | — | — |

¹ Availability depends on the installed agent and the current session.

- **Cursor Agent:** a Bun-based runner, the stock versioned launcher for build `2026.11.22-e9042b2`, and a compatible local ACP store. Sessions started with Cursor-native worktree or additional directory flags, legacy stream-json sessions, and unrecognized builds keep the controls hidden.
- **Grok Build:** its fork and rewind extension methods.
- **OpenCode:** the v2 history API. OpenCode v1 never gets these controls. Rewind also needs v2's staged revert endpoints.
- **Pi:** its fork and history-entry RPC commands. HAPI's code assumes Pi 0.83 or later.

Export works for every session, whatever the agent.

## Fork

A fork creates a new HAPI session from a copy of the agent's native conversation and opens it. Its title starts as **Fork: _source title_**. The new session gets the transcript up to the fork point, and the source session isn't changed.

### Fork from the latest turn

When the agent finishes a turn, a **Fork** button appears in the action row of the latest message. Forking there keeps the whole conversation so far.

### Fork at a message

On agents that support it, earlier user messages also show **Fork**. The new session keeps everything **before** that message. The message you picked and everything after it are left out, so you can send a different prompt from that point.

A message gets the button only if HAPI recorded a native history point for it. Messages from before the agent supported history points, or messages HAPI couldn't map to a native turn, have no button.

### Fork while Codex is working

Codex can fork a completed turn while another turn is still running:

- **In chat:** user messages whose turns have completed keep their **Fork** button while Codex works on a later turn.
- **From the session list:** open the session's menu and choose **Fork session**. If a turn is running, HAPI forks **through the last completed turn**. The running turn is left out, and the source session keeps working. If no turn has completed yet, the action is disabled and explains why.

### Fork an archived Codex session

You can also fork an inactive Codex session from its chat, or an archived one from the session list. The source machine must be online, and its runner must support archived Codex forks. HAPI forks the stored native thread without reopening the source and without sending it a prompt. For recovery details, see [Codex shared sessions → Fork an archived conversation](./codex-shared-sessions.md#fork-an-archived-conversation).

### When fork is unavailable

HAPI refuses a fork, apart from the Codex cases above, when:

- the agent is still working on a turn
- the session has queued messages that haven't been sent yet
- the session is running in local (terminal) mode. Use remote mode. Codex shared sessions don't have this restriction.
- the session's native history no longer matches HAPI's copy

## Rewind

**Rewind** appears on user messages for Grok Build, OpenCode v2, Pi and supported Cursor ACP sessions. It removes that message and everything after it from the session, both in the agent's native history and in HAPI's transcript. You then continue from the turn before it. After you confirm, the chat refreshes to the shortened history.

::: warning
Rewind permanently deletes the later conversation, and files are not restored. To keep the original, fork instead.
:::

You can't rewind while the agent is working, while messages are queued, in local (terminal) mode, or on an inactive session. Codex doesn't offer rewind. Fork at the message instead.

### Cursor checkpoints and recovery

HAPI records a boundary when a single plain-text user prompt matches one new native Cursor turn and its stored checkpoint. After a restart, fork or rewind, only newly verified messages gain checkpoints. Fork from the latest turn remains available when the current store can be verified.

Rewind keeps the HAPI session ID. HAPI first loads an independent native copy at the checkpoint. The Hub then saves the new Cursor ID and shortens the transcript in a single transaction. The original Cursor store stays on disk. The Hub allows up to 255 seconds on the HTTP request so a slow native load can finish both RPC phases. If the runner disconnects during confirmation, resume the HAPI session to load the ID the Hub committed. Workspace files stay untouched.

## Branch with options

**Branch with options** starts a brand-new session in a harness you choose, seeded with the conversation's visible text. A fork copies the agent's internal state. A branch doesn't, so it works across harnesses: you can branch a Claude conversation into Codex, or the other way round.

**Where:** web app only. Use the **Options** button (fork icon) in a message's action row:

- **On a user message:** choose how much history to keep:
  - **Before this user message**
  - **Through this message, until the next user input**
- **On the latest completed reply:** the branch keeps everything through the latest completed turn.

**Options in the dialog:**

| Option | Choices |
|--------|---------|
| Harness | Claude Code or Codex |
| Model | **Harness default**, or a model from the source machine's catalog for that harness |
| Workspace | **Use the current directory**, or **Create a Git worktree from current HEAD**. A new worktree doesn't copy uncommitted changes. |
| First instruction | Required, up to 16,000 characters |

**What carries over:** only user/assistant text and tool observations, labelled as historical reference. Hidden reasoning, system prompts, attachments and native session state are not carried over. The new session is titled **Branch: _source title_** and shows a banner that links back to the source.

**Requirements and limits:**

- The source must be a Claude or Codex session, and its machine must be online.
- The source can't have a turn running or queued messages. Inactive sources can be branched.
- The reference text must fit in 256 KiB. If it doesn't, pick an earlier boundary.

If the request fails or its response is lost, submit the dialog again without changing any options. HAPI then recovers the same branch session instead of creating a second one.

## Export

Export the conversation from the web app's session header menu or the session list's action menu (**Export conversation**):

| Format | Contents |
|--------|----------|
| **JSON** | Lossless payload: session metadata, all visible messages and scratchlist notes. Attachments are included as metadata only (name, type, size, path), not file contents. |
| **Markdown** | A readable document generated from the same payload |

The file is named `<title>-<id prefix>-<date>.json` or `.md`.

- **Over 20,000 messages:** HAPI warns you first. You can still choose **Download anyway**.
- **Estimated over 100 MB:** the hub refuses the export.

## Mobile apps

| Action | Web / PWA | iOS | Android |
|--------|-----------|-----|---------|
| Fork latest turn | Yes | Yes (chat menu → **Fork Conversation**) | — |
| Fork at a message / rewind | Yes | Yes (chat menu → **Rewind or Fork…**) | — |
| Fork from session list, fork archived Codex | Yes | — | — |
| Branch with options | Yes | — | — |
| Export | JSON and Markdown | JSON only, saved through Files | — |

On iOS, **Rewind or Fork…** opens a sheet of the loaded user messages that have a native history point. Each row offers **Fork from Here** or **Rewind to Here**, gated like the web app:

- **Fork:** the turn must be idle, except on Codex.
- **Rewind:** always needs an idle turn.

iOS fork and rewind work only on active sessions. Large or oversized exports show the same warning or limit as on the web. The Android app doesn't offer these actions yet. Use the web app or PWA instead.
