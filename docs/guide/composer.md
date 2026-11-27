---
description: "Send, queue, steer, schedule and automate messages to your agent; pick model and effort; attach files; use slash commands, mentions and keyboard shortcuts."
---

# Composer

The composer is the input box at the bottom of a chat. Besides sending text, it lets you queue or steer messages while the agent is busy, schedule a message for later, set up repeat and queue tasks that the hub sends on their own, switch model and effort, attach files, and reference other sessions.

This page covers the web app and PWA, plus the iOS and Android apps where they differ. Voice input and dictation are covered in [Voice input and assistant](./voice-assistant.md).

## Sending while the agent is working

### Queue (default)

A message you send while the agent is mid-turn is **queued**. It is not lost or dropped — it waits in a small bar above the composer and is delivered when the current turn ends.

Each queued row has (a prompt sent by a repeat or queue task is the exception, see [Repeat and queue tasks](#repeat-and-queue-tasks)):

- **Edit** — cancels the queued message and puts its text (and schedule, if any) back in the composer.
- **Cancel** — removes it.
- **Steer** — shown only when the agent supports it (see below).

Sending in the web app always queues. To push a queued message into the running turn, press its **Steer** button.

### Steer

**Steer** delivers a queued message into the turn that is already running, instead of waiting for it to finish. The agent picks it up at its next safe point. A delivered message is marked **↳ Steered** in the conversation.

| Agent | Steer support |
|-------|---------------|
| Claude | Yes, remote mode only. Claude folds the message in at the next tool boundary. Steering denies any permission request that is still waiting. |
| Codex | Yes |
| OpenCode | Yes |
| Cursor | Yes for ACP sessions. Older stream-json Cursor sessions cannot steer. |
| Antigravity | Yes when running over `agy acp`. The steer is folded in after any running tool call finishes. |
| Pi | Yes |
| Gemini, Kimi, Copilot, Grok Build, DeepSeek Harness | No — messages always queue |

Steer appears only while the session is active, a turn is running, and the session is controlled remotely (not from the local terminal). Scheduled messages cannot be steered.

If HAPI cannot confirm whether a steer reached the agent, the row says so and offers **Retry** or **Cancel**. A failed steer leaves the message in the queue.

### On iOS and Android

The queued-message bar works the same way, with **Steer**, **Edit**, and **Cancel** per row. The native apps also let you steer at send time: while a steerable turn is running, **long-press Send** and choose **Send & steer into current turn**. A normal tap queues.

## Scheduled send

Use the **clock** button in the composer toolbar to send a message later.

- **Relative** presets: +5m, +30m, +1h, +4h. The delay is counted from when you press Send, not from when you pick the preset.
- **Specific** time: any time up to 7 days ahead.

Scheduled messages appear in the queued-message bar as **Scheduled for …**, sorted by fire time after any immediate queued messages. You can edit or cancel them until they fire.

Limits:

- Maximum 7 days ahead; the time must be in the future.
- Scheduled messages cannot carry attachments. The attach button is disabled while a schedule is set.
- The hub must be running at the scheduled time. If the session is not running then, the hub resumes it. If its machine is offline, the message goes out when the machine is back.

Scheduled send is available on web, iOS (clock menu with the same presets plus **Pick a Time…**), and Android (clock button with Relative and Specific tabs).

## Repeat and queue tasks

The same clock button (**Schedule and tasks**) has two more modes on the web app. Both hand a schedule to the hub, which then sends the prompts into the conversation on its own, as if you had typed them.

- **Repeat**: one message, sent on a fixed interval (at least one minute, at most 30 days). It starts now or at a time you pick (within a year), and runs until you pause or delete it — or, if you set a number of runs, until it has run that many times.
- **Queue**: a list of messages, sent in order. The first goes out at once (or at the time you pick); each following one goes out one interval after the agent **took** the previous one, so the gap is measured from the agent, not from the send.

A **Repeat** task uses what is already in the composer as its message until you type something else in the panel. A **Queue** offers the composer's text as its first message the same way: the first row shows it as a placeholder, and the composer is emptied once the queue exists.

The queue editor has one field per message with **Add message**, and remove, move up and move down per row. A message may span several lines — lists, code, several paragraphs — because **Enter inserts a line break** in a prompt field (the task is created by its button, or with Ctrl/Cmd+Enter). Blank rows are ignored; a queue needs at least one message and holds at most 50.

Tasks are listed in the **Tasks** bar above the composer, with what runs next and these actions per task:

- **Pause / Resume** stops new prompts or continues. A prompt already sent stays in the queue and still counts.
- **Run now** sends the next prompt at once, also on a paused task, which becomes active again and then follows its interval. It is withheld while one of the task's prompts is still waiting for the agent: a task never has more than one prompt out.
- **Edit** opens the task's fields under the row — the same fields as the clock panel's form. For a **Repeat** task: the message, the interval and the run limit. For a **Queue**: only the messages not sent yet, and the gap; the ones already sent stay as they are. **Save changes** sends only what you changed; **Escape** closes the editor. If the queue sends a message while the editor is open, **Save changes** first refreshes the rows to what is left and asks you to review and save again, so a message that went out is never queued twice.
- **Delete** asks first (**Keep task / Delete**), because the messages not sent yet exist only in the task. Deleting also cancels a prompt the agent has not taken yet; if that cancel could not be confirmed, a note says so and the row stays in the queued-message bar for you to retry or discard.

**History** in the bar's header shows what the tasks did: every prompt sent (and whether the agent took it), every skipped slot, every failed run with its reason, and prompts cancelled. Runs stay after their task is gone, so a finished queue or repeat task can still be looked up there; the bar stays for the history alone.

In the session list, a session with active tasks shows a repeat symbol next to the scheduled-message clock, with the task count and the next run on hover.

How the hub runs them:

- A task never has more than one prompt waiting. A **Repeat** task that comes due while its previous prompt is still queued skips that slot instead of stacking a second one on a busy agent. The skipped slot shows in the history.
- Each message goes out one interval after the agent took the previous one. If the session is not running when a task is due, the hub resumes it first; an archived session is never woken, and its tasks wait until it is reopened.
- A hub restart loses nothing: a run that was missed while the hub was down goes out once when it is back, and a **Repeat** task then returns to its original grid.
- If the session's machine is offline, the task waits and shows **Sends once the machine is back online**. Other reasons are shown the same way — the session cannot be resumed right now, the session is archived, the prompt was sent but whether the agent took it is unknown (retry or discard it in the queued messages), the agent has not taken the prompt, or the send failed. None of these pauses the task: it stays due and goes on by itself once the cause is gone.
- A finished task removes itself from the list; its prompts stay in the conversation and its runs in the history. A session may hold at most 20 active tasks.

In the queued-message bar, a prompt a task sent is marked **From task**. It offers **Skip this message** (the prompt is cancelled, which the history lists as **Cancelled**, and the task moves on: a queue sends its next message one gap after the skip, a repeat task keeps its grid) and, when its delivery is uncertain, **Retry** — but not **Edit** or **Steer**: the task tracks that row. Once it has gone out, the message keeps the **From task** mark in the conversation, so it does not read as something you typed.

Tasks run with the session's permission mode. Where that mode does not ask before it acts, the Repeat and Queue forms say so.

Tasks are text-only and have no 7-day limit. The iOS and Android apps cannot create them yet; prompts a task sends show up in their threads like any other message (without the **From task** mark), and the session list there does not mark them yet.

## Model and effort

Open the composer **Settings** button (or the model/effort buttons in the toolbar) to change the model, effort, and permission mode for the running session. Changes apply to the next turn.

| Agent | Model | Effort |
|-------|-------|--------|
| Claude | Yes | Yes — switched in place, without restarting Claude |
| Codex | Yes | Yes (reasoning effort, per model) |
| OpenCode | Yes | Yes, for models that advertise effort options |
| DeepSeek Harness | Yes | Yes |
| Cursor | Yes | Via model variants |
| Antigravity | Yes | Yes, when the model offers effort options |
| Copilot | Yes | Yes |
| Kimi | Yes | Yes (thinking level) |
| Grok Build | Yes | Yes, when the model offers effort options |
| Pi | Yes (provider-grouped picker) | Yes, hidden for models without reasoning |
| Gemini | Yes | No |

Most of these controls need an active session in remote mode; they are hidden or disabled while you are driving the session from the local terminal. The unset choice is shown as **Default** everywhere.

### Codex fast mode

When the current Codex model advertises a Fast service tier for your account, the composer shows a **Fast mode** toggle (Standard / Fast). It is hidden for models or accounts without a Fast tier, such as API-key sessions. The new-session form remembers your last Fast choice for Codex.

### On iOS and Android

Model and effort live in the session settings sheet (the gear in the chat). Codex Fast mode is available when creating a new session.

## Keyboard shortcuts (web)

| Shortcut | Action |
|----------|--------|
| Enter | Send (or insert a newline, if **Settings → Chat → Enter Key** is set to *Insert newline*) |
| Ctrl/Cmd+Enter | Send, when Enter is set to insert a newline |
| Shift+Enter | New line |
| Alt+S | Send, regardless of the Enter Key setting |
| Esc | Close the settings panel or suggestions; otherwise stop the running turn; otherwise collapse the expanded editor |
| Shift+Tab | Cycle permission mode |
| Ctrl/Cmd+M | Cycle model (not available for Pi) |
| Ctrl/Cmd+Shift+D | Start or stop dictation / voice assistant |
| Ctrl/Cmd+Shift+S | Toggle the Scratchlist |
| ↑ / ↓, Tab | Move through and pick suggestions |

## Suggestions: `/`, `@`, and `$`

Typing a trigger character opens a suggestion list.

- **`/` slash commands** — the agent's built-in commands plus user, project, and plugin commands the CLI discovers. Codex built-ins that HAPI cannot run remotely (for example `/review`, `/undo`, `/diff`) show a notice instead; use natural language or run them in the local Codex TUI.
- **`@` session mentions** — mention another HAPI session. In the web app it becomes a chip; on send, the message includes that session's full ID so the agent can `inspect_peer` or `ping_peer` it (see [Peer sessions](./peer-sessions.md)). Inactive sessions are grouped in a collapsible section.
- **`@` file mentions** — Codex and Copilot sessions also list files from the session's working directory.
- **`$` skills** — skills available to the session.

The iOS and Android apps support slash-command suggestions and `@` session and file mentions (files for Codex and Copilot).

## Attachments

Attach files with the paperclip button, drag and drop, or paste (images and other files). Multiple attachments can be reordered before sending; a failed upload can be retried.

On narrow screens the web app shows a source picker with **Photos**, **Camera**, and **Files**. The iOS app offers **Photo library**, **Camera**, and **Files**.

### Size limits

- **Web:** files larger than 8 MB are uploaded in chunks, so large files do not have to fit in browser memory. The default limit is **512 MiB per file**. Change it with `HAPI_MAX_UPLOAD_BYTES` (bytes, capped at 10 GiB). The hub and the CLI each enforce this variable, so set it on both. If the CLI is too old for chunked uploads, the web app falls back to a single upload limited to 50 MB.
- **iOS and Android:** up to 50 MB per file. Images larger than 4 MB are downscaled to 2048 px on the longest edge and re-encoded as JPEG before upload.

Attachments cannot be combined with scheduled send.

## Context meter and plan quota

The status line above the composer shows how full the agent's context window is (for example `36% · 72k / 200k`, or `ctx 200k (64% left)` on narrow screens). It turns amber at 70% used and red at 90%. Click it for details: used, remaining, and cache tokens.

When the session's machine reports plan quotas for the agent, a compact readout appears next to it, such as `5h 42% (2h13m) · 7d 18%` — percent used and time until reset for the 5-hour and weekly windows. It turns amber at 20% remaining and red at 5%, and refreshes every two minutes. Click it for a per-window breakdown. Quotas are currently reported for Claude, Codex, and Antigravity; see [Usage and quotas](./usage-and-quotas.md).

On Android, context remaining is shown in the session settings sheet under **Context**.

## Generation rate (tok/s)

For Claude, Codex, OpenCode, and Antigravity, a reply's **Message details** (the info icon) include the round's duration, turn count, and generation rate in tokens per second. The rate is measured over generation time, excluding time spent running tools.

## Concise view (web)

Long tasks can bury the conversation under tool calls. **Concise view** shows only your messages and each round's final reply. Tool calls, reasoning, and progress updates are hidden; permission requests, questions, plan proposals, and errors stay visible.

Toggle it from the session header or **Settings → Chat → Concise view**. It is off by default and saved per device.

## Other composer features

- **Drafts** are saved per session and restored when you come back.
- **Scratchlist** parks notes and drafts without sending them. Send adds to the Scratchlist while it is open; from there you can copy an entry into the composer or send it to the queue. Entries sync across devices.
- **Toolbar layout** — reorder or hide toolbar buttons under **Settings → Chat → Customize composer toolbar layout**.
