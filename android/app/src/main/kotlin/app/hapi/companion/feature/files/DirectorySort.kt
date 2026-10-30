package app.hapi.companion.feature.files

import app.hapi.protocol.wire.DirectoryEntry
import app.hapi.protocol.wire.FileSearchItem

/**
 * Browse-tree / search sort choice — the Android twin of web
 * `directory-sort.ts`. Web persists `{field, direction}` under the
 * localStorage key `hapi-directory-sort`; Android mirrors it with two keys in
 * the app-wide `hapi_prefs` DataStore ([DirectorySortPrefs]).
 */
enum class DirectorySortField(val storageKey: String) {
    NAME("name"),
    MODIFIED("modified"),
    SIZE("size");

    companion object {
        /** Unknown/corrupt stored values degrade to [NAME] (web validation twin). */
        fun fromStorageKey(raw: String?): DirectorySortField? =
            entries.firstOrNull { it.storageKey == raw }
    }
}

enum class DirectorySortDirection(val storageKey: String) {
    ASC("asc"),
    DESC("desc");

    companion object {
        fun fromStorageKey(raw: String?): DirectorySortDirection? =
            entries.firstOrNull { it.storageKey == raw }
    }
}

data class DirectorySort(
    val field: DirectorySortField = DirectorySortField.NAME,
    val direction: DirectorySortDirection = DirectorySortDirection.ASC,
) {
    companion object {
        /** Web `DEFAULT_DIRECTORY_SORT`: name A→Z. */
        val DEFAULT = DirectorySort()
    }
}

/**
 * Pure sort logic (web `directory-sort.ts` twin — same file drives the web
 * tests `directory-sort.test.ts`):
 *
 * - directory entries: directories always precede files; under `size` the
 *   directories themselves stay name-ascending (a directory has no meaningful
 *   size);
 * - `modified`/`size` compare numerically with missing values always last,
 *   regardless of direction; ties break by name ascending;
 * - names use a natural, case-insensitive order (web `Intl.Collator` with
 *   `numeric: true`, `sensitivity: 'base'`): digit runs compare numerically so
 *   `file2` < `file10`. Java's `Collator` has no numeric mode, so the digit
 *   awareness is hand-rolled here; accent folding beyond lowercasing is not
 *   attempted (the practical name corpus is ASCII).
 */
object DirectorySortLogic {

    /** Web `sortDirectoryEntries` (dirs-first variant for the Browse tree). */
    fun sortEntries(entries: List<DirectoryEntry>, sort: DirectorySort): List<DirectoryEntry> =
        entries.sortedWith(entriesComparator(sort))

    /** Web `sortFileSearchItems` (flat list — no dirs-first rule). */
    fun sortSearchItems(items: List<FileSearchItem>, sort: DirectorySort): List<FileSearchItem> =
        items.sortedWith(searchComparator(sort))

    fun entriesComparator(sort: DirectorySort): Comparator<DirectoryEntry> = Comparator { left, right ->
        val leftDir = left.type == "directory"
        val rightDir = right.type == "directory"
        when {
            leftDir != rightDir -> if (leftDir) -1 else 1
            // Directories have no meaningful size: keep them alphabetic.
            sort.field == DirectorySortField.SIZE && leftDir ->
                compareNames(left.name, right.name, DirectorySortDirection.ASC)
            else -> entryFieldCompare(left.name, left.modified, left.size, right.name, right.modified, right.size, sort)
        }
    }

    fun searchComparator(sort: DirectorySort): Comparator<FileSearchItem> = Comparator { left, right ->
        entryFieldCompare(left.fileName, left.modified, left.size, right.fileName, right.modified, right.size, sort)
    }

    private fun entryFieldCompare(
        leftName: String,
        leftModified: Long?,
        leftSize: Long?,
        rightName: String,
        rightModified: Long?,
        rightSize: Long?,
        sort: DirectorySort,
    ): Int = when (sort.field) {
        DirectorySortField.NAME -> compareNames(leftName, rightName, sort.direction)
        DirectorySortField.MODIFIED ->
            compareOptionalNumbers(leftModified, rightModified, sort.direction)
                .takeIf { it != 0 }
                ?: compareNames(leftName, rightName, DirectorySortDirection.ASC)
        DirectorySortField.SIZE ->
            compareOptionalNumbers(leftSize, rightSize, sort.direction)
                .takeIf { it != 0 }
                ?: compareNames(leftName, rightName, DirectorySortDirection.ASC)
    }

    /** Web `compareOptionalNumbers`: missing values sink regardless of direction. */
    private fun compareOptionalNumbers(
        left: Long?,
        right: Long?,
        direction: DirectorySortDirection,
    ): Int {
        if (left == null && right == null) return 0
        if (left == null) return 1
        if (right == null) return -1
        return if (direction == DirectorySortDirection.ASC) left.compareTo(right) else right.compareTo(left)
    }

    private fun compareNames(left: String, right: String, direction: DirectorySortDirection): Int {
        val result = naturalNameCompare(left, right)
        return if (direction == DirectorySortDirection.ASC) result else -result
    }

    /**
     * Natural, case-insensitive comparison: alphanumeric runs compare
     * numerically (`file2` < `file10`), other chunks char-wise lowercased.
     */
    fun naturalNameCompare(left: String, right: String): Int {
        var li = 0
        var ri = 0
        while (li < left.length && ri < right.length) {
            val lc = left[li]
            val rc = right[ri]
            if (lc.isDigit() && rc.isDigit()) {
                val lEnd = digitRunEnd(left, li)
                val rEnd = digitRunEnd(right, ri)
                val cmp = compareDigitRuns(left.substring(li, lEnd), right.substring(ri, rEnd))
                if (cmp != 0) return cmp
                li = lEnd
                ri = rEnd
            } else {
                val cmp = lc.lowercaseChar().compareTo(rc.lowercaseChar())
                if (cmp != 0) return cmp
                li++
                ri++
            }
        }
        // Whoever still has characters left sorts after the exhausted prefix.
        return (left.length - li) - (right.length - ri)
    }

    private fun digitRunEnd(s: String, start: Int): Int {
        var i = start
        while (i < s.length && s[i].isDigit()) i++
        return i
    }

    /** Equal-value runs with different zero padding compare as equal. */
    private fun compareDigitRuns(left: String, right: String): Int {
        val lTrimmed = left.trimStart('0')
        val rTrimmed = right.trimStart('0')
        val byLength = lTrimmed.length.compareTo(rTrimmed.length)
        if (byLength != 0) return byLength
        return lTrimmed.compareTo(rTrimmed)
    }
}
