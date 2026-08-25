package app.hapi.protocol.wire

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Regression: `fs.stat`-derived epoch fields arrive **fractional** from real
 * hubs (`"startedCliMtimeMs":1786932205158.1177` observed in a live DB); a
 * plain `Long` decode threw and took the whole machines/files response down —
 * on device that pinned an "offline" banner over a perfectly live list.
 */
class LenientEpochMsTest {
    @Test
    fun `machine metadata decodes fractional cli mtimes`() {
        val machine = HapiJson.decodeFromString(
            Machine.serializer(),
            """
            {"id":"m1","namespace":"default","seq":1,"createdAt":1,"updatedAt":2,
             "active":true,"activeAt":3,"metadataVersion":1,"runnerStateVersion":0,
             "metadata":{"host":"h","platform":"linux","happyCliVersion":"0.28.0",
                         "startedCliMtimeMs":1786932205158.1177,
                         "installedCliMtimeMs":1786501585709.12}}
            """.trimIndent(),
        )
        assertEquals(1786932205158L, machine.metadata?.startedCliMtimeMs)
        assertEquals(1786501585709L, machine.metadata?.installedCliMtimeMs)
    }

    @Test
    fun `integral mtimes still decode`() {
        val machine = HapiJson.decodeFromString(
            Machine.serializer(),
            """
            {"id":"m1","namespace":"default","seq":1,"createdAt":1,"updatedAt":2,
             "active":true,"activeAt":3,"metadataVersion":1,"runnerStateVersion":0,
             "metadata":{"host":"h","platform":"linux","happyCliVersion":"0.28.0",
                         "startedCliMtimeMs":1786932205158}}
            """.trimIndent(),
        )
        assertEquals(1786932205158L, machine.metadata?.startedCliMtimeMs)
    }

    @Test
    fun `directory entries and file reads decode fractional modified`() {
        val dir = HapiJson.decodeFromString(
            DirectoryEntry.serializer(),
            """{"name":"src","type":"directory","modified":1786932205158.9}""",
        )
        assertEquals(1786932205158L, dir.modified)

        val machineDir = HapiJson.decodeFromString(
            MachineDirectoryEntry.serializer(),
            """{"name":"repo","type":"directory","modified":1786932205158.5,"isGitRepo":true}""",
        )
        assertEquals(1786932205158L, machineDir.modified)

        val read = HapiJson.decodeFromString(
            FileReadResponse.serializer(),
            """{"success":true,"content":"aGk=","size":2,"modified":1786932205158.0001}""",
        )
        assertEquals(1786932205158L, read.modified)

        val search = HapiJson.decodeFromString(
            FileSearchItem.serializer(),
            """{"fileName":"a.ts","filePath":"src","fullPath":"src/a.ts","fileType":"file","modified":1786932205159.75}""",
        )
        assertEquals(1786932205159L, search.modified)
    }
}
