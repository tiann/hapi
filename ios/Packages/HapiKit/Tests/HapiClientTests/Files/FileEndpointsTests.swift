import Foundation
import HapiClient
import HapiProtocol
import Testing

/// Request construction + response decoding of the git/files endpoints
/// (A-M4a) against the recording performer, mirroring the Android
/// `HapiApi` git & files section and `docs/api/client-contract/rest.md`.
@Suite("File endpoint requests")
struct FileEndpointsTests {

    @Test func gitStatusBuildsPathAndDecodesCommandResponse() async throws {
        let harness = try makeHarness(jwt: freshJWT())
        await harness.performer.enqueue(
            // ##-delimited: the payload contains `"#`, which would terminate
            // a single-# raw string early.
            json: ##"{"success":true,"stdout":"# branch.head main\n","exitCode":0}"##
        )

        let response = try await harness.client.gitStatus(sessionId: "s 1")
        #expect(response.success)
        #expect(response.stdout == "# branch.head main\n")
        #expect(response.exitCode == 0)

        let request = await harness.performer.requests.first
        #expect(request?.url?.absoluteString == "\(testHubURLString)/api/sessions/s%201/git-status")
        #expect(request?.httpMethod == "GET")
    }

    @Test func gitDiffNumstatCarriesStagedFlag() async throws {
        let harness = try makeHarness(jwt: freshJWT())
        await harness.performer.enqueue(json: #"{"success":true,"stdout":""}"#)
        await harness.performer.enqueue(json: #"{"success":true,"stdout":""}"#)

        _ = try await harness.client.gitDiffNumstat(sessionId: "abc", staged: true)
        _ = try await harness.client.gitDiffNumstat(sessionId: "abc", staged: false)

        let requests = await harness.performer.requests
        #expect(
            requests.first?.url?.absoluteString
                == "\(testHubURLString)/api/sessions/abc/git-diff-numstat?staged=true"
        )
        #expect(
            requests.last?.url?.absoluteString
                == "\(testHubURLString)/api/sessions/abc/git-diff-numstat?staged=false"
        )
    }

    @Test func gitDiffFileEncodesPathAndOptionalStaged() async throws {
        let harness = try makeHarness(jwt: freshJWT())
        await harness.performer.enqueue(json: #"{"success":true,"stdout":""}"#)
        await harness.performer.enqueue(json: #"{"success":false,"error":"boom"}"#)

        _ = try await harness.client.gitDiffFile(sessionId: "abc", path: "src/app.ts", staged: false)
        let second = try await harness.client.gitDiffFile(sessionId: "abc", path: "src/app.ts")
        #expect(second.success == false)
        #expect(second.error == "boom")

        let requests = await harness.performer.requests
        #expect(
            requests.first?.url?.absoluteString
                == "\(testHubURLString)/api/sessions/abc/git-diff-file?path=src%2Fapp.ts&staged=false"
        )
        // Omitted staged flag stays off the URL (unstaged side).
        #expect(
            requests.last?.url?.absoluteString
                == "\(testHubURLString)/api/sessions/abc/git-diff-file?path=src%2Fapp.ts"
        )
    }

    @Test func readSessionFileEncodesPathStrictly() async throws {
        let harness = try makeHarness(jwt: freshJWT())
        await harness.performer.enqueue(
            json: #"{"success":true,"content":"aGk=","size":2,"modified":1700000000000}"#
        )

        let response = try await harness.client.readSessionFile(sessionId: "abc", path: "a b+c.txt")
        #expect(response.content == "aGk=")
        #expect(response.size == 2)
        #expect(response.modified == 1_700_000_000_000)

        let request = await harness.performer.requests.first
        #expect(
            request?.url?.absoluteString
                == "\(testHubURLString)/api/sessions/abc/file?path=a%20b%2Bc.txt"
        )
    }

    @Test func searchSessionFilesOmitsEmptyQueryAndNilLimit() async throws {
        let harness = try makeHarness(jwt: freshJWT())
        await harness.performer.enqueue(json: """
        {"success":true,"files":[{"fileName":"app.ts","filePath":"src",\
        "fullPath":"src/app.ts","fileType":"file","size":10}]}
        """)
        await harness.performer.enqueue(json: #"{"success":true,"files":[]}"#)

        let response = try await harness.client.searchSessionFiles(
            sessionId: "abc",
            query: "app",
            limit: 200
        )
        #expect(response.files?.map(\.fullPath) == ["src/app.ts"])
        _ = try await harness.client.searchSessionFiles(sessionId: "abc", query: "", limit: nil)

        let requests = await harness.performer.requests
        #expect(
            requests.first?.url?.absoluteString
                == "\(testHubURLString)/api/sessions/abc/files?query=app&limit=200"
        )
        #expect(requests.last?.url?.absoluteString == "\(testHubURLString)/api/sessions/abc/files")
    }

    @Test func listSessionDirectoryOmitsRootPathAndDecodesEntryTypes() async throws {
        let harness = try makeHarness(jwt: freshJWT())
        await harness.performer.enqueue(json: """
        {"success":true,"entries":[{"name":"src","type":"directory"},\
        {"name":"main.ts","type":"file","size":5,"modified":123},\
        {"name":"sock","type":"other"}]}
        """)
        await harness.performer.enqueue(json: #"{"success":false,"error":"denied"}"#)

        let root = try await harness.client.listSessionDirectory(sessionId: "abc")
        #expect(root.entries == [
            DirectoryEntry(name: "src", type: .directory),
            DirectoryEntry(name: "main.ts", type: .file, size: 5, modified: 123),
            DirectoryEntry(name: "sock", type: .other),
        ])

        let nested = try await harness.client.listSessionDirectory(sessionId: "abc", path: "src/app")
        #expect(nested.success == false)
        #expect(nested.error == "denied")

        let requests = await harness.performer.requests
        #expect(requests.first?.url?.absoluteString == "\(testHubURLString)/api/sessions/abc/directory")
        #expect(
            requests.last?.url?.absoluteString
                == "\(testHubURLString)/api/sessions/abc/directory?path=src%2Fapp"
        )
    }
}
