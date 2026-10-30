package app.hapi.protocol.chat

import app.hapi.protocol.wire.TodoItem
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Test

class SessionStatusTest {

    private fun toolBlock(
        name: String,
        toolId: String = "tool-$name",
        blockId: String = "block-$name",
        state: String = "running",
        input: JsonObject = buildJsonObject { },
        result: kotlinx.serialization.json.JsonElement? = null,
        startedAt: Double? = null,
        completedAt: Double? = null,
        description: String? = null,
        createdAt: Long = 100,
        children: List<ChatBlock> = emptyList(),
    ): ToolCallBlock = ToolCallBlock(
        id = blockId,
        localId = null,
        createdAt = createdAt,
        invokedAt = null,
        tool = ChatToolCall(
            id = toolId,
            name = name,
            state = state,
            input = input,
            createdAt = createdAt,
            startedAt = startedAt,
            completedAt = completedAt,
            description = description,
            result = result,
        ),
        children = children,
        meta = null,
    )

    private fun taskNotification(taskId: String?, createdAt: Long = 200): NormalizedMessage.Agent =
        NormalizedMessage.Agent(
            id = "notification-${taskId ?: "anonymous"}",
            localId = null,
            createdAt = createdAt,
            isSidechain = true,
            content = listOf(
                NormalizedAgentContent.Sidechain(
                    uuid = "notification",
                    prompt = "<task-notification>" +
                        (taskId?.let { "<task-id>$it</task-id>" } ?: "") +
                        "<summary>Done</summary></task-notification>",
                ),
            ),
        )

    private fun goalObject(
        status: String = "active",
        objective: String = "Ship status panel",
        timeUsedSeconds: Double = 120.0,
    ): JsonObject = buildJsonObject {
        put("threadId", "thread-1")
        put("objective", objective)
        put("status", status)
        put("tokenBudget", JsonNull)
        put("tokensUsed", 10_000.0)
        put("timeUsedSeconds", timeUsedSeconds)
        put("createdAt", 1.0)
        put("updatedAt", 2.0)
    }

    private fun terminalBlocks(): List<ChatBlock> = listOf(
        toolBlock(
            name = "Agent",
            state = "completed",
            children = listOf(
                toolBlock(
                    name = "Bash",
                    toolId = "bash-1",
                    state = "completed",
                    input = buildJsonObject {
                        put("command", "bun run dev")
                        put("cwd", "/repo/web")
                    },
                    result = kotlinx.serialization.json.JsonPrimitive("Command running in background with ID: bg-1"),
                    startedAt = 123.0,
                ),
                toolBlock(
                    name = "Bash",
                    toolId = "bash-2",
                    state = "completed",
                    input = buildJsonObject { put("command", "bun test --watch") },
                    result = buildJsonArray {
                        add(
                            buildJsonObject {
                                put("type", "text")
                                put("text", "Command running in background with ID: bg-2")
                            },
                        )
                    },
                ),
                toolBlock(
                    name = "Read",
                    state = "completed",
                    result = kotlinx.serialization.json.JsonPrimitive(
                        "Command running in background with ID: not-a-terminal",
                    ),
                ),
            ),
        ),
    )

    // ------------------------------------------------------------- null rule --

    @Test
    fun `returns null when the session has no live status`() {
        assertNull(buildSessionStatusData(goal = null, tasks = emptyList(), blocks = emptyList(), messages = emptyList()))
        assertNull(buildSessionStatusData(goal = null, tasks = null, blocks = emptyList(), messages = emptyList()))
    }

    @Test
    fun `keeps goal and ordered task snapshots`() {
        val goal = goalObject()
        val tasks = listOf(
            TodoItem(content = "Research", status = "completed", priority = "medium", id = "1"),
            TodoItem(content = "Implement", status = "in_progress", priority = "high", id = "2"),
        )

        val data = buildSessionStatusData(goal = goal, tasks = tasks, blocks = emptyList(), messages = emptyList())!!

        assertEquals("Ship status panel", data.goal?.objective)
        assertEquals("active", data.goal?.status)
        assertEquals(120.0, data.goal?.timeUsedSeconds)
        assertEquals(tasks, data.tasks)
        assertEquals(0, data.subagents.size)
        assertEquals(0, data.terminals.size)
        assertEquals(0, data.undiscoveredTerminalCount)
    }

    private fun SessionStatusData.dataTasksInOrder(): List<TodoItem> = tasks

    @Test
    fun `drops a malformed goal object instead of rendering it`() {
        val malformed = buildJsonObject {
            put("threadId", "thread-1")
            put("status", "active")
        }
        assertNull(buildSessionStatusData(goal = malformed, tasks = emptyList(), blocks = emptyList(), messages = emptyList()))
    }

    // ------------------------------------------------------------ subagents --

    @Test
    fun `lists only active or failed subagents`() {
        val blocks = listOf(
            toolBlock(
                name = "CodexAgent",
                toolId = "agent-1",
                state = "running",
                input = buildJsonObject {
                    put("summary", "Inspect API")
                    put("activity", "Reading files")
                },
            ),
            toolBlock(
                name = "Agent",
                toolId = "agent-2",
                state = "error",
                input = buildJsonObject { put("description", "Review changes") },
            ),
            toolBlock(
                name = "Agent",
                toolId = "agent-pending",
                state = "pending",
                input = buildJsonObject { put("description", "Needs permission") },
            ),
            toolBlock(
                name = "Task",
                toolId = "agent-3",
                state = "completed",
                input = buildJsonObject { put("description", "Done") },
                children = listOf(
                    toolBlock(
                        name = "Agent",
                        toolId = "agent-4",
                        input = buildJsonObject { put("description", "Nested work") },
                    ),
                ),
            ),
        )

        val subagents = buildSessionStatusData(goal = null, tasks = emptyList(), blocks = blocks, messages = emptyList())!!
            .subagents

        assertEquals(listOf("agent-1", "agent-2", "agent-pending", "agent-4"), subagents.map { it.id })
        val first = subagents[0]
        assertEquals("Inspect API", first.title)
        assertEquals("Reading files", first.detail)
        assertEquals(SessionSubagentState.RUNNING, first.state)
        assertEquals(100L, first.startedAt)
        assertNull(first.endedAt)
        val second = subagents[1]
        assertEquals("Review changes", second.title)
        assertEquals(SessionSubagentState.ERROR, second.state)
        assertEquals(100L, second.endedAt)
        val pending = subagents[2]
        assertEquals(SessionSubagentState.WAITING, pending.state)
        assertNull(pending.startedAt)
        assertNull(pending.endedAt)
        val nested = subagents[3]
        assertEquals("Nested work", nested.title)
        assertEquals(SessionSubagentState.RUNNING, nested.state)
    }

    @Test
    fun `marks a subagent waiting when its live activity says waiting`() {
        val blocks = listOf(
            ToolCallBlock(
                id = "block-Agent", localId = null, createdAt = 100, invokedAt = null,
                tool = ChatToolCall(
                    id = "waiting-1", name = "Agent", state = "running",
                    input = buildJsonObject { put("description", "Asking a question") },
                    createdAt = 100, description = null,
                ),
                children = listOf(
                    toolBlock(name = "AskUserQuestion", toolId = "ask-1", state = "completed")
                        .let { it.tool = it.tool.copy(nativeTitle = "Waiting for operator"); it },
                ),
                meta = null,
            ),
        )
        val fromChild = buildSessionStatusData(goal = null, tasks = emptyList(), blocks = blocks, messages = emptyList())!!
            .subagents.single()
        assertEquals(SessionSubagentState.WAITING, fromChild.state)
        assertEquals("Waiting for operator", fromChild.detail)

        val fromActivity = buildSessionStatusData(
            goal = null, tasks = emptyList(),
            blocks = listOf(
                toolBlock(
                    name = "CodexAgent",
                    toolId = "waiting-2",
                    state = "running",
                    input = buildJsonObject { put("activity", "waiting for approval") },
                ),
            ),
            messages = emptyList(),
        )!!.subagents.single()
        assertEquals(SessionSubagentState.WAITING, fromActivity.state)
        assertEquals("waiting for approval", fromActivity.detail)
    }

    @Test
    fun `collapses whitespace and truncates long subagent titles`() {
        val longDescription = ("Fix   the\n\n login   flow " + "x".repeat(120))
        val subagent = buildSessionStatusData(
            goal = null, tasks = emptyList(),
            blocks = listOf(
                toolBlock(
                    name = "Agent",
                    toolId = "t-1",
                    input = buildJsonObject { put("description", longDescription) },
                ),
            ),
            messages = emptyList(),
        )!!.subagents.single()

        val expected = truncate(collapse(longDescription), 100)
        assertEquals(expected, subagent.title)
        assertEquals(100, subagent.title.length)
        assertTrue(subagent.title.endsWith("..."))
    }

    private fun collapse(text: String): String = text.replace(Regex("\\s+"), " ").trim()

    @Test
    fun `summarizes agent prompts by stripping markup noise and task prefixes`() {
        fun titleFor(input: JsonObject): String =
            buildSessionStatusData(
                goal = null, tasks = emptyList(),
                blocks = listOf(toolBlock(name = "CodexAgent", toolId = "c-1", input = input)),
                messages = emptyList(),
            )!!.subagents.single().title

        assertEquals(
            "Investigate the build failure",
            titleFor(buildJsonObject { put("prompt", "Task: Investigate the build failure") }),
        )
        assertEquals(
            "repo notes Please review everything",
            titleFor(
                buildJsonObject {
                    put(
                        "prompt",
                        "<context>repo notes</context>\n- Please review everything\nDo not revert recent changes",
                    )
                },
            ),
        )
        assertEquals("code-reviewer agent", titleFor(buildJsonObject { put("agent_type", "code-reviewer") }))
        assertEquals("Agent", titleFor(buildJsonObject { }))
    }

    @Test
    fun `rewords non-terminal completed activity lines`() {
        val activity = codexAgentActivity(
            buildJsonObject {
                put("activity", "Command completed for the linter")
                put("status", "running")
            },
        )
        assertEquals("Command finished for the linter", activity)
        assertEquals(
            "Command completed for the linter",
            codexAgentActivity(
                buildJsonObject {
                    put("activity", "Command completed for the linter")
                    put("status", "completed")
                },
            ),
        )
        assertNull(codexAgentActivity(buildJsonObject { }))
    }

    // ------------------------------------------------------------ terminals --

    @Test
    fun `tracks background terminals until their task notification arrives`() {
        val blocks = terminalBlocks()

        val stillRunning = buildSessionStatusData(
            goal = null, tasks = emptyList(), blocks = blocks,
            messages = listOf(taskNotification("bg-1")),
        )!!.terminals
        assertEquals(listOf(SessionStatusTerminal(id = "bg-2", command = "bun test --watch", cwd = null, startedAt = 100)), stillRunning)

        assertNull(
            buildSessionStatusData(
                goal = null, tasks = emptyList(), blocks = blocks, messages = emptyList(),
                backgroundTaskCount = 0,
            ),
        )
        val unknownOnly = buildSessionStatusData(
            goal = null, tasks = emptyList(), blocks = emptyList(), messages = emptyList(),
            backgroundTaskCount = 2,
        )!!
        assertEquals(0, unknownOnly.terminals.size)
        assertEquals(2, unknownOnly.undiscoveredTerminalCount)

        val anonymous = buildSessionStatusData(
            goal = null, tasks = emptyList(), blocks = blocks,
            messages = listOf(taskNotification(taskId = null)),
            backgroundTaskCount = 1,
        )!!
        assertEquals(0, anonymous.terminals.size)
        assertEquals(1, anonymous.undiscoveredTerminalCount)
        assertEquals(listOf("bun run dev", "bun test --watch"), anonymous.possibleTerminalCommands)
    }

    @Test
    fun `keeps terminals started after an anonymous notice as confirmed`() {
        val blocks = listOf(
            toolBlock(
                name = "Bash",
                toolId = "bash-late",
                state = "completed",
                input = buildJsonObject { put("command", "cargo watch") },
                result = kotlinx.serialization.json.JsonPrimitive("Command running in background with ID: bg-late"),
                startedAt = 300.0,
            ),
            toolBlock(
                name = "Bash",
                toolId = "bash-old",
                state = "completed",
                input = buildJsonObject { put("command", "bun run dev") },
                result = kotlinx.serialization.json.JsonPrimitive("Command running in background with ID: bg-old"),
                startedAt = 100.0,
            ),
        )
        val data = buildSessionStatusData(
            goal = null, tasks = emptyList(), blocks = blocks,
            messages = listOf(taskNotification(taskId = null)),
            backgroundTaskCount = 1,
        )!!
        assertEquals(listOf("bg-late"), data.terminals.map { it.id })
        assertEquals(0, data.undiscoveredTerminalCount)
        assertEquals(0, data.possibleTerminalCommands.size)
    }

    @Test
    fun `parses command arrays, cwd aliases and markup-bounded task ids`() {
        val blocks = listOf(
            toolBlock(
                name = "Bash",
                toolId = "bash-array",
                state = "completed",
                input = buildJsonObject {
                    put("command", buildJsonArray {
                        add(kotlinx.serialization.json.JsonPrimitive("bun"))
                        add(kotlinx.serialization.json.JsonPrimitive("run"))
                        add(kotlinx.serialization.json.JsonPrimitive("dev"))
                    })
                    put("workdir", "/repo")
                },
                result = kotlinx.serialization.json.JsonPrimitive("Command running in background with ID: bg-9</task-id>"),
            ),
        )
        val terminal = buildSessionStatusData(goal = null, tasks = emptyList(), blocks = blocks, messages = emptyList())!!
            .terminals.single()
        assertEquals("bg-9", terminal.id)
        assertEquals("bun run dev", terminal.command)
        assertEquals("/repo", terminal.cwd)
        assertEquals(100L, terminal.startedAt)
    }

    @Test
    fun `prefers an explicit command over description and tool name`() {
        fun commandFor(input: JsonObject?, description: String?): String =
            buildSessionStatusData(
                goal = null, tasks = emptyList(),
                blocks = listOf(
                    toolBlock(
                        name = "Bash", toolId = "bash-x", state = "completed",
                        input = input ?: buildJsonObject { },
                        description = description,
                        result = kotlinx.serialization.json.JsonPrimitive("Command running in background with ID: bg-x"),
                    ),
                ),
                messages = emptyList(),
            )!!.terminals.single().command

        assertEquals("npm start", commandFor(buildJsonObject { put("cmd", "npm start") }, "ignored"))
        // An empty description is present, so it wins over the tool name.
        assertEquals("", commandFor(null, ""))
        assertEquals("Bash", commandFor(null, null))
    }

    @Test
    fun `uses the latest anonymous notice time across several notices`() {
        val blocks = listOf(
            toolBlock(
                name = "Bash",
                toolId = "bash-1",
                state = "completed",
                input = buildJsonObject { put("command", "make watch") },
                result = kotlinx.serialization.json.JsonPrimitive("Command running in background with ID: bg-1"),
                startedAt = 150.0,
            ),
        )
        val data = buildSessionStatusData(
            goal = null, tasks = emptyList(), blocks = blocks,
            messages = listOf(taskNotification(taskId = null, createdAt = 120), taskNotification(taskId = null, createdAt = 260)),
            backgroundTaskCount = null,
        )!!
        // 150 <= 260 (the later anonymous notice) → uncertain, and with no
        // authoritative count every uncertain terminal is still listed.
        assertEquals(listOf("bg-1"), data.terminals.map { it.id })
        assertEquals(0, data.possibleTerminalCommands.size)
        assertEquals(0, data.undiscoveredTerminalCount)
    }

    // ---------------------------------------------------------- live timers --

    @Test
    fun `reports live elapsed only while something is still moving`() {
        assertFalseHasLive(
            SessionStatusData(
                subagents = listOf(SessionStatusSubagent(id = "a", title = "A", state = SessionSubagentState.ERROR, startedAt = 10L, endedAt = 20L)),
            ),
        )
        assertTrueHasLive(
            SessionStatusData(
                terminals = listOf(SessionStatusTerminal(id = "t", command = "x", startedAt = 10L)),
            ),
        )
        assertTrueHasLive(
            SessionStatusData(
                subagents = listOf(SessionStatusSubagent(id = "a", title = "A", state = SessionSubagentState.RUNNING, startedAt = 10L)),
            ),
        )
        assertFalseHasLive(
            SessionStatusData(
                subagents = listOf(SessionStatusSubagent(id = "p", title = "P", state = SessionSubagentState.WAITING)),
            ),
        )
    }

    private fun assertFalseHasLive(data: SessionStatusData) = kotlin.test.assertFalse(data.hasLiveElapsed)
    private fun assertTrueHasLive(data: SessionStatusData) = kotlin.test.assertTrue(data.hasLiveElapsed)

    // ------------------------------------------------------------ durations --

    @Test
    fun `formats compact durations`() {
        assertEquals("0.0s", formatCompactDuration(0.0))
        assertEquals("12.3s", formatCompactDuration(12_340.0))
        assertEquals("59.9s", formatCompactDuration(59_940.0))
        assertEquals("1m", formatCompactDuration(60_000.0))
        assertEquals("1m 1s", formatCompactDuration(61_000.0))
        assertEquals("1m 31s", formatCompactDuration(90_500.0))
        assertEquals("2h 2m 2s", formatCompactDuration(7_322_000.0))
        assertEquals("1h", formatCompactDuration(3_600_000.0))
        assertEquals("1h 1m 1s", formatCompactDuration(3_661_000.0))
    }

    @Test
    fun `elapsed text clamps at zero and hides unknown starts`() {
        assertNull(elapsedSince(null, now = 1_000))
        assertNull(elapsedSince(0L, now = 1_000))
        assertNull(elapsedSince(-5L, now = 1_000))
        assertEquals("50.0s", elapsedSince(100L, now = 50_100))
        assertEquals("0.0s", elapsedSince(200L, now = 150))
        // Finished rows pass the end instant, so the clock cannot move them.
        assertEquals("45.0s", elapsedSince(100L, now = 45_100))
    }
}
