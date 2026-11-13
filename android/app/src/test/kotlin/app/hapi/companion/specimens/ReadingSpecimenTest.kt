package app.hapi.companion.specimens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Modifier
import app.hapi.companion.feature.chat.ResponseActions
import app.hapi.companion.feature.chat.ResponseFooter
import app.hapi.companion.feature.chat.blocks.AgentReasoningBlockView
import app.hapi.companion.ui.markdown.Markdown
import app.hapi.protocol.chat.AgentReasoningBlock
import app.hapi.protocol.chat.AgentTextBlock
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xxhdpi")
class ReadingSpecimenTest {
    @get:Rule val compose = createComposeRule()

    @Test fun markdownLight() = markdown(SpecimenTheme.Light)
    @Test fun markdownDark() = markdown(SpecimenTheme.Dark)
    @Test fun markdownOled() = markdown(SpecimenTheme.Oled)

    @Test fun responseActionsLight() = responseActions(SpecimenTheme.Light)
    @Test fun responseActionsDark() = responseActions(SpecimenTheme.Dark)

    @Test fun reasoningLight() = reasoning(SpecimenTheme.Light)
    @Test fun reasoningDark() = reasoning(SpecimenTheme.Dark)

    private fun markdown(theme: SpecimenTheme) {
        compose.setContent { Specimen(theme) { Markdown(MARKDOWN_SAMPLE) } }
        compose.captureSpecimen("markdown", theme)
    }

    private fun responseActions(theme: SpecimenTheme) {
        val answer = AgentTextBlock(
            id = "a1", localId = null, createdAt = 0, invokedAt = null, model = "claude-opus-4-5",
            text = "修好了：游标现在同时携带 `beforeAt` 和 `beforeSeq`，翻页不再重复。", meta = null,
        )
        val footer = ResponseFooter(copyText = answer.text, detailsBlock = answer, timestamp = System.currentTimeMillis())
        compose.setContent {
            Specimen(theme) {
                Markdown(answer.text)
                ResponseActions(footer, onShowDetails = {})
                Markdown("Tool-only responses keep just the time:", modifier = Modifier.padding(top = 20.dp))
                ResponseActions(footer.copy(copyText = null, detailsBlock = null), onShowDetails = {})
            }
        }
        compose.captureSpecimen("response-actions", theme)
    }

    private fun reasoning(theme: SpecimenTheme) {
        compose.setContent {
            Specimen(theme) {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    AgentReasoningBlockView(reasoningBlock("r-collapsed"))
                    AgentReasoningBlockView(reasoningBlock("r-expanded"))
                    Markdown("修好了：游标现在同时携带 `beforeAt` 和 `beforeSeq`，翻页不再重复。")
                }
            }
        }
        compose.onAllNodesWithTag("reasoning-toggle")[1].performClick()
        compose.captureSpecimen("reasoning", theme)
    }

    private fun reasoningBlock(id: String) = AgentReasoningBlock(
        id = id,
        localId = null,
        createdAt = 0,
        invokedAt = null,
        text = "用户要修分页。先看 `MessagePosition` 的游标对：如果只带 `beforeSeq`，" +
            "hub 会返回 `reset: true`，客户端就会重复第一页。\n\n" +
            "- Check the cursor pair\n- Then the window trim",
        meta = null,
    )
}

internal val MARKDOWN_SAMPLE = """
# 分页修复说明

The failing test was a **cursor regression** in the history pager. 翻页时游标丢了 `beforeAt` 的一半，所以 hub 认为请求无效，返回了 `reset: true`。

## 根因

1. `beforeSeq` lost its `beforeAt` half
2. the hub returned `reset: true`，客户端随后从头加载
3. 结果：第一页被渲染两次

### 修复

- 构造游标时总是成对携带 `at` 与 `seq`
- Added a regression test for the **empty window** case
  - nested item with a [link](https://hapi.run)

```kotlin
val cursor = MessagePosition(at = row.createdAt, seq = row.seq)
if (cursor.isComplete) loadBefore(cursor)
```

> 注意：旧版本 hub 仍可能返回 `reset`，客户端需要容忍一次重复。

| 场景 | Before | After |
|---|---|---|
| 首屏 | 2 次请求 | 1 次请求 |
| 翻页 | 重复 | 正常 |

---

完成后运行 `./gradlew :app:testDebugUnitTest` 验证。
""".trimIndent()
