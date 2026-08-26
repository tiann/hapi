import Foundation
import HapiProtocol
import Testing

/// Inline numstat samples with expectations produced by running the exact
/// inputs through `parseNumStat`/`createDiffStatsMap` in
/// `web/src/lib/gitParsers.ts` — transcribed from the Android reference
/// suite (`NumstatParserTest.kt`).
@Suite("NumstatParser")
struct NumstatParserTests {

    @Test func parsesCountsTotalsAndBinaryMarkers() {
        let summary = NumstatParser.parse("3\t1\tsrc/app.ts\n5\t2\tboth.txt\n-\t-\timage.png")

        #expect(summary.files == [
            DiffFileStat(file: "src/app.ts", changes: 4, insertions: 3, deletions: 1, binary: false),
            DiffFileStat(file: "both.txt", changes: 7, insertions: 5, deletions: 2, binary: false),
            DiffFileStat(file: "image.png", changes: 0, insertions: 0, deletions: 0, binary: true),
        ])
        #expect(summary.insertions == 8)
        #expect(summary.deletions == 3)
        #expect(summary.changes == 11)
        #expect(summary.changed == 3)
    }

    @Test func blankAndMalformedLinesAreIgnored() {
        let summary = NumstatParser.parse("\n\nnot numstat\n1\t2\tok.txt\n")

        #expect(summary.changed == 1)
        #expect(summary.files.first?.file == "ok.txt")
        #expect(NumstatParser.parse("").files.isEmpty)
    }

    @Test func statsMapIndexesRawPathPlusNormalizedBraceRenamePaths() {
        let map = NumstatParser.statsMap(NumstatParser.parse("0\t0\t{old => new}/name.ts"))

        let stat = DiffLineStats(added: 0, removed: 0, binary: false)
        #expect(map["{old => new}/name.ts"] == stat)
        #expect(map["new/name.ts"] == stat)
        #expect(map["old/name.ts"] == stat)
        #expect(map.count == 3)
    }

    @Test func statsMapIndexesPlainArrowRenames() {
        let map = NumstatParser.statsMap(NumstatParser.parse("2\t3\told.txt => new.txt"))

        let stat = DiffLineStats(added: 2, removed: 3, binary: false)
        #expect(map["old.txt => new.txt"] == stat)
        #expect(map["new.txt"] == stat)
        #expect(map["old.txt"] == stat)
    }

    @Test func statsMapKeepsBinaryFlagAndPlainPaths() {
        let map = NumstatParser.statsMap(NumstatParser.parse("-\t-\tassets/logo.png\n7\t0\tREADME.md"))

        #expect(map["assets/logo.png"] == DiffLineStats(added: 0, removed: 0, binary: true))
        #expect(map["README.md"] == DiffLineStats(added: 7, removed: 0, binary: false))
        #expect(map["missing.txt"] == nil)
        #expect(map.count == 2)
    }

    @Test func midPathBraceRenameNormalizesBothSides() {
        let paths = NumstatParser.normalizePath("src/{components => ui}/Button.tsx")

        #expect(paths.newPath == "src/ui/Button.tsx")
        #expect(paths.oldPath == "src/components/Button.tsx")
    }

    @Test func pathWithoutRenameMarkersPassesThroughTrimmed() {
        let paths = NumstatParser.normalizePath("  plain/path.txt  ")

        #expect(paths.newPath == "plain/path.txt")
        #expect(paths.oldPath == nil)
    }
}
