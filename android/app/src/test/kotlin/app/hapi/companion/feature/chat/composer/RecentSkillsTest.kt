package app.hapi.companion.feature.chat.composer

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest

class RecentSkillsTest {

    @Test
    fun `advance lowercases the key so mixed-case picks share one entry`() {
        val first = RecentSkillsLogic.advance(emptyMap(), "Code-Review", at = 100)
        assertEquals(mapOf("code-review" to 100L), first)

        // The differently-cased pick updates the same entry instead of
        // forking the history — the lookup side keys on lowercase.
        val second = RecentSkillsLogic.advance(first, "code-review", at = 200)
        assertEquals(mapOf("code-review" to 200L), second)
    }

    @Test
    fun `markUsed stores lowercase names`() = runTest {
        val recent = InMemoryRecentSkills()
        recent.markUsed("Zeta", at = 100)
        assertEquals(mapOf("zeta" to 100L), recent.timestamps.first())
    }
}
