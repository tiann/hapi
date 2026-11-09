package app.hapi.companion.feature.files

import kotlin.test.Test
import kotlin.test.assertEquals

/** Twin of web `file-path.test.ts` plus `formatFileReference` (file-composer). */
class FilePathsTest {

    @Test
    fun `joins a relative path onto a POSIX workspace root`() {
        assertEquals(
            "/home/me/project/src/foo.ts",
            FilePaths.resolveAbsoluteFilePath("/home/me/project", "src/foo.ts"),
        )
    }

    @Test
    fun `keeps a single leading separator when the root is slash`() {
        assertEquals("/etc/hosts", FilePaths.resolveAbsoluteFilePath("/", "etc/hosts"))
    }

    @Test
    fun `trims trailing separators from the root`() {
        assertEquals(
            "/home/me/project/src/foo.ts",
            FilePaths.resolveAbsoluteFilePath("/home/me/project/", "src/foo.ts"),
        )
    }

    @Test
    fun `preserves literal backslashes in POSIX relative paths`() {
        assertEquals(
            "/home/me/project/src/file\\name.ts",
            FilePaths.resolveAbsoluteFilePath("/home/me/project", "src/file\\name.ts"),
        )
    }

    @Test
    fun `treats a POSIX root containing a backslash as POSIX`() {
        assertEquals(
            "/home/me\\project/src/foo.ts",
            FilePaths.resolveAbsoluteFilePath("/home/me\\project", "src/foo.ts"),
        )
    }

    @Test
    fun `joins a Windows-looking filename when the workspace is POSIX`() {
        assertEquals("/project/C:\\notes.txt", FilePaths.resolveAbsoluteFilePath("/project", "C:\\notes.txt"))
        assertEquals("/project/C:/notes.txt", FilePaths.resolveAbsoluteFilePath("/project", "C:/notes.txt"))
    }

    @Test
    fun `uses backslashes for Windows roots and converts forward slashes`() {
        assertEquals(
            "C:\\Users\\me\\project\\src\\foo.ts",
            FilePaths.resolveAbsoluteFilePath("C:\\Users\\me\\project", "src/foo.ts"),
        )
    }

    @Test
    fun `handles a bare drive root`() {
        assertEquals("C:\\src\\foo.ts", FilePaths.resolveAbsoluteFilePath("C:", "src/foo.ts"))
    }

    @Test
    fun `returns the relative path when there is no workspace`() {
        assertEquals("src/foo.ts", FilePaths.resolveAbsoluteFilePath(null, "src/foo.ts"))
        assertEquals("src/foo.ts", FilePaths.resolveAbsoluteFilePath("", "src/foo.ts"))
    }

    @Test
    fun `does not double-join an already absolute path`() {
        assertEquals("/etc/hosts", FilePaths.resolveAbsoluteFilePath("/root", "/etc/hosts"))
        assertEquals("D:\\other\\file.ts", FilePaths.resolveAbsoluteFilePath("C:\\root", "D:\\other\\file.ts"))
        assertEquals("\\\\server\\share\\x.ts", FilePaths.resolveAbsoluteFilePath("C:\\root", "\\\\server\\share\\x.ts"))
    }

    @Test
    fun `returns the workspace when the relative path is empty`() {
        assertEquals("/home/me/project", FilePaths.resolveAbsoluteFilePath("/home/me/project", ""))
    }

    @Test
    fun `empty relative path with no workspace returns empty`() {
        assertEquals("", FilePaths.resolveAbsoluteFilePath(null, ""))
        assertEquals("", FilePaths.resolveAbsoluteFilePath("", ""))
    }

    @Test
    fun `formatFileReference wraps the path in backticks`() {
        assertEquals("`src/app.ts`", FilePaths.formatFileReference("src/app.ts"))
        assertEquals("``", FilePaths.formatFileReference(""))
    }
}
