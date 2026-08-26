import Foundation
import HapiProtocol

/// Owner-only dashboard endpoints (A-M4d). Both answer `403` unless the JWT
/// namespace is `default`
/// (`docs/api/client-contract/rest.md#usage--storage-owner-only`).
extension APIClient {
    /// `GET /api/usage/summary?range=7d|30d|all&timeZone=<IANA>` — token-usage
    /// dashboard aggregates. The hub validates `timeZone` (400 when invalid)
    /// and buckets `daily` by that zone's calendar days.
    public func usageSummary(
        range: String = "7d",
        timeZone: String = "UTC"
    ) async throws -> UsageSummaryResponse {
        try await request(.get, "/api/usage/summary", query: [
            URLQueryItem(name: "range", value: range),
            URLQueryItem(name: "timeZone", value: timeZone),
        ])
    }

    /// `GET /api/storage/sqlite` — hub db/wal/shm file sizes.
    public func sqliteStorageUsage() async throws -> SqliteStorageUsageResponse {
        try await request(.get, "/api/storage/sqlite")
    }
}
