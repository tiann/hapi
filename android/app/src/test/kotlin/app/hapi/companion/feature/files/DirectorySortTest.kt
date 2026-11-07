package app.hapi.companion.feature.files

import app.hapi.protocol.wire.DirectoryEntry
import app.hapi.protocol.wire.FileSearchItem
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Twin of web `directory-sort.test.ts` (same fixture shapes and expectations),
 * plus the natural-order and storage-key units the web suite exercises
 * indirectly through `Intl.Collator`.
 */
class DirectorySortTest {

    // Same fixture as the web suite: unknown.txt has no size/modified.
    private val entries = listOf(
        DirectoryEntry(name = "large.txt", type = "file", size = 500L, modified = 20L),
        DirectoryEntry(name = "folder-b", type = "directory", size = 999L, modified = 30L),
        DirectoryEntry(name = "small.txt", type = "file", size = 10L, modified = 10L),
        DirectoryEntry(name = "unknown.txt", type = "file"),
        DirectoryEntry(name = "folder-a", type = "directory", size = 1L, modified = 5L),
    )

    private val results = listOf(
        FileSearchItem(
            fileName = "large10.txt", filePath = "src", fullPath = "src/large10.txt",
            fileType = "file", size = 500L, modified = 20L,
        ),
        FileSearchItem(
            fileName = "small2.txt", filePath = "src", fullPath = "src/small2.txt",
            fileType = "file", size = 10L, modified = 10L,
        ),
        FileSearchItem(fileName = "unknown.txt", filePath = "src", fullPath = "src/unknown.txt", fileType = "file"),
    )

    private fun names(entries: List<DirectoryEntry>) = entries.map { it.name }
    private fun fileNames(items: List<FileSearchItem>) = items.map { it.fileName }

    // ------------------------------------------------------------- entries --

    @Test
    fun `defaults to folders first and name ascending`() {
        assertEquals(
            listOf("folder-a", "folder-b", "large.txt", "small.txt", "unknown.txt"),
            names(DirectorySortLogic.sortEntries(entries, DirectorySort(DirectorySortField.NAME, DirectorySortDirection.ASC))),
        )
    }

    @Test
    fun `sorts files by size while keeping folders alphabetic`() {
        assertEquals(
            listOf("folder-a", "folder-b", "large.txt", "small.txt", "unknown.txt"),
            names(DirectorySortLogic.sortEntries(entries, DirectorySort(DirectorySortField.SIZE, DirectorySortDirection.DESC))),
        )
    }

    @Test
    fun `sorts by modified time and leaves missing metadata last`() {
        assertEquals(
            listOf("folder-b", "folder-a", "large.txt", "small.txt", "unknown.txt"),
            names(DirectorySortLogic.sortEntries(entries, DirectorySort(DirectorySortField.MODIFIED, DirectorySortDirection.DESC))),
        )
    }

    @Test
    fun `name descending still keeps folders first`() {
        assertEquals(
            listOf("folder-b", "folder-a", "unknown.txt", "small.txt", "large.txt"),
            names(DirectorySortLogic.sortEntries(entries, DirectorySort(DirectorySortField.NAME, DirectorySortDirection.DESC))),
        )
    }

    @Test
    fun `missing values sink in ascending order too`() {
        assertEquals(
            listOf("folder-a", "folder-b", "small.txt", "large.txt", "unknown.txt"),
            names(DirectorySortLogic.sortEntries(entries, DirectorySort(DirectorySortField.SIZE, DirectorySortDirection.ASC))),
        )
    }

    @Test
    fun `equal field values tie-break by name ascending`() {
        val tied = listOf(
            DirectoryEntry(name = "b.txt", type = "file", size = 5L),
            DirectoryEntry(name = "a.txt", type = "file", size = 5L),
        )
        assertEquals(
            listOf("a.txt", "b.txt"),
            names(DirectorySortLogic.sortEntries(tied, DirectorySort(DirectorySortField.SIZE, DirectorySortDirection.DESC))),
        )
    }

    // ------------------------------------------------------------- search --

    @Test
    fun `uses natural filename ordering`() {
        assertEquals(
            listOf("large10.txt", "small2.txt", "unknown.txt"),
            fileNames(DirectorySortLogic.sortSearchItems(results, DirectorySort(DirectorySortField.NAME, DirectorySortDirection.ASC))),
        )
    }

    @Test
    fun `sorts metadata and keeps missing values last`() {
        assertEquals(
            listOf("small2.txt", "large10.txt", "unknown.txt"),
            fileNames(DirectorySortLogic.sortSearchItems(results, DirectorySort(DirectorySortField.SIZE, DirectorySortDirection.ASC))),
        )
        assertEquals(
            listOf("large10.txt", "small2.txt", "unknown.txt"),
            fileNames(DirectorySortLogic.sortSearchItems(results, DirectorySort(DirectorySortField.MODIFIED, DirectorySortDirection.DESC))),
        )
    }

    @Test
    fun `search has no folders-first rule`() {
        val mixed = listOf(
            FileSearchItem(fileName = "z-dir", filePath = "", fullPath = "z-dir", fileType = "directory"),
            FileSearchItem(fileName = "a.txt", filePath = "", fullPath = "a.txt", fileType = "file"),
        )
        assertEquals(
            listOf("a.txt", "z-dir"),
            fileNames(DirectorySortLogic.sortSearchItems(mixed, DirectorySort.DEFAULT)),
        )
    }

    // ------------------------------------------------------- natural names --

    @Test
    fun `digit runs compare numerically`() {
        assertTrue(DirectorySortLogic.naturalNameCompare("file2", "file10") < 0)
        assertTrue(DirectorySortLogic.naturalNameCompare("file10", "file2") > 0)
        assertEquals(0, DirectorySortLogic.naturalNameCompare("file10", "file10"))
    }

    @Test
    fun `comparison is case-insensitive and zero padding is equal`() {
        assertEquals(0, DirectorySortLogic.naturalNameCompare("README.md", "readme.md"))
        assertEquals(0, DirectorySortLogic.naturalNameCompare("a007.txt", "a7.txt"))
        // Case-folded, so 'B' compares as 'b' — still after 'a'.
        assertTrue(DirectorySortLogic.naturalNameCompare("B.txt", "a.txt") > 0)
    }

    // --------------------------------------------------------- storage keys --

    @Test
    fun `storage keys round-trip and unknown values reject`() {
        for (field in DirectorySortField.entries) {
            assertEquals(field, DirectorySortField.fromStorageKey(field.storageKey))
        }
        for (direction in DirectorySortDirection.entries) {
            assertEquals(direction, DirectorySortDirection.fromStorageKey(direction.storageKey))
        }
        assertNull(DirectorySortField.fromStorageKey("bogus"))
        assertNull(DirectorySortField.fromStorageKey(null))
        assertNull(DirectorySortDirection.fromStorageKey("42"))
        assertNull(DirectorySortDirection.fromStorageKey(null))
    }
}
