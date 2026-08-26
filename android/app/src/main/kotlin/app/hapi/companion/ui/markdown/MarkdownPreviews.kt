package app.hapi.companion.ui.markdown

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.tooling.preview.PreviewParameter
import androidx.compose.ui.tooling.preview.PreviewParameterProvider
import androidx.compose.ui.unit.dp
import app.hapi.companion.ui.components.DiffView
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.protocol.git.UnifiedDiffParser

/**
 * Kitchen-sink markdown exercising every renderer path (headings, emphasis,
 * strikethrough, inline code + file citations, links incl. blocked/custom
 * schemes, CJK autolink artifacts, lists + task lists, blockquote, tables --
 * one streaming-truncated, fenced code, mermaid degradation, html fallback,
 * thematic break). Compile-checked previews double as visual regressions.
 */
class MarkdownPreviewParameterProvider : PreviewParameterProvider<String> {
    override val values: Sequence<String> = sequenceOf(KITCHEN_SINK_MARKDOWN)
}

// A ~ in a raw string: kept literal; ${'$'} escapes are not needed below.
val KITCHEN_SINK_MARKDOWN: String = """
# Release notes

Shipped the **markdown pipeline** with *italics*, ~~strikeouts~~, and `inline code`.
Edit `web/src/lib/remark-repair-tables.ts` or jump to hub/src/startHub.ts:345 directly.

Links: [docs](https://example.com/docs), [guide](docs/guide.md#install),
[blocked](/settings), vscode://file/readme.md, and https://example.com/a，中文标点。

## Checklist

- [x] port transforms
- [ ] wire chat surface
- plain bullet

1. first
2. second with `a/b.ts:12`

> Quoted wisdom with **bold** and a [link](https://example.com).

| Column A | Column B | Column C |
| --- | --- |
| left | 2 | `x|y` |

```kotlin
fun greet(name: String): String {
    // returns a greeting
    return "Hello, ${'$'}name!"
}
```

```mermaid
graph TD; A-->B;
```

<div class="html-block">raw html falls back to monospace</div>

---

Done. See CHANGELOG.md.
""".trimIndent()

private val SAMPLE_DIFF = """
diff --git a/src/app.ts b/src/app.ts
index 83db48f..bf269f4 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@ function main()
 import fs from 'fs'
-const a = 1
+const a = 2
+const b = 3
 console.log(a)
 export {}
@@ -10,2 +11,2 @@
 tail1
-tail2
+tail2!
""".trimIndent()

@Preview(name = "Markdown light", showBackground = true, heightDp = 1400)
@Composable
private fun MarkdownPreviewLight(
    @PreviewParameter(MarkdownPreviewParameterProvider::class) text: String,
) {
    HapiTheme(darkTheme = false, dynamicColor = false) {
        Surface {
            Markdown(
                text = text,
                modifier = Modifier
                    .verticalScroll(rememberScrollState())
                    .padding(16.dp),
            )
        }
    }
}

@Preview(name = "Markdown dark", showBackground = true, backgroundColor = 0xFF1C1C1E, heightDp = 1400)
@Composable
private fun MarkdownPreviewDark(
    @PreviewParameter(MarkdownPreviewParameterProvider::class) text: String,
) {
    HapiTheme(darkTheme = true, dynamicColor = false) {
        Surface {
            Markdown(
                text = text,
                modifier = Modifier
                    .verticalScroll(rememberScrollState())
                    .padding(16.dp),
            )
        }
    }
}

@Preview(name = "Diff + code OLED", showBackground = true, backgroundColor = 0xFF000000)
@Composable
private fun DiffAndCodeOledPreview() {
    HapiTheme(darkTheme = true, dynamicColor = false, oled = true) {
        Surface {
            val file = remember { UnifiedDiffParser.parse(SAMPLE_DIFF).first() }
            Column(
                modifier = Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                DiffView(file = file, compact = true, compactLineLimit = 8)
                CodeBlock(
                    code = "fun sum(a: Int, b: Int) = a + b",
                    language = "kotlin",
                )
            }
        }
    }
}
