import Foundation
import HapiClient
import HapiProtocol
import Testing

/// Donut slice math — twin of `storageUsageSlices.test.ts` semantics.
/// Transcribed from the Android `StorageMathTest`.
@Suite("StorageMath")
struct StorageMathTests {

    private func usage(db: Int, wal: Int, shm: Int) -> SqliteStorageUsageResponse {
        SqliteStorageUsageResponse(
            path: "/x/hapi.db",
            databaseBytes: db,
            walBytes: wal,
            shmBytes: shm,
            totalBytes: db + wal + shm
        )
    }

    @Test func slicesKeepEntityOrderAndPartitionTheFullCircle() {
        let slices = StorageMath.slices(usage(db: 750, wal: 200, shm: 50))

        #expect(slices.map(\.key) == [.database, .wal, .shm])
        #expect(slices.first?.startAngle == StorageMath.startAngle)
        #expect(slices.last?.endAngle == StorageMath.startAngle + 360)
        // Contiguous: each slice starts where the previous ended.
        for (previous, next) in zip(slices, slices.dropFirst()) {
            #expect(previous.endAngle == next.startAngle)
        }
        #expect(slices[0].percent == 75.0)
        #expect(slices[1].percent == 20.0)
        #expect(slices[2].percent == 5.0)
        // db = 75% of the circle.
        #expect(abs((slices[0].endAngle - slices[0].startAngle) - 270) < 0.001)
    }

    @Test func zeroByteFilesAreDroppedWithoutRepaintingTheSurvivors() {
        let slices = StorageMath.slices(usage(db: 100, wal: 0, shm: 25))
        #expect(slices.map(\.key) == [.database, .shm])
        #expect(slices.last?.endAngle == StorageMath.startAngle + 360)
        #expect(slices[0].percent == 80.0)
    }

    @Test func allZeroUsageYieldsNoSlices() {
        #expect(StorageMath.slices(usage(db: 0, wal: 0, shm: 0)).isEmpty)
        // Negative (corrupt) sizes are treated as zero, not drawn.
        #expect(StorageMath.slices(usage(db: -10, wal: 0, shm: 0)).isEmpty)
    }

    @Test func percentRoundsToOneDecimal() {
        let slices = StorageMath.slices(usage(db: 1, wal: 2, shm: 0))
        #expect(slices[0].percent == 33.3)
        #expect(slices[1].percent == 66.7)
    }

    @Test func formatPercentDropsTheDecimalOnWholeNumbers() {
        #expect(StorageMath.formatPercent(75.0) == "75%")
        #expect(StorageMath.formatPercent(33.3) == "33.3%")
        #expect(StorageMath.formatPercent(97.25) == "97.3%")
        #expect(StorageMath.formatPercent(0.0) == "0%")
        #expect(StorageMath.formatPercent(100.0) == "100%")
    }
}
