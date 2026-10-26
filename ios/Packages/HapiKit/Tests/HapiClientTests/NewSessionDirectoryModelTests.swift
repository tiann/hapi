import Foundation
import HapiClient
import HapiProtocol
import Testing

private struct ListingCall: Hashable, Sendable {
    let machineId: String
    let path: String
    var includeHidden = false
}

private struct ExistenceCall: Hashable, Sendable {
    let machineId: String
    let path: String
}

private actor DirectoryRequester: NewSessionDirectoryRequesting {
    private(set) var listings: [ListingCall] = []
    private(set) var checks: [ExistenceCall] = []
    private(set) var completedListings: [ListingCall] = []
    private(set) var completedChecks: [ExistenceCall] = []
    private var heldListings: Set<ListingCall> = []
    private var heldChecks: Set<ExistenceCall> = []
    private var listingWaiters: [ListingCall: CheckedContinuation<Void, Never>] = [:]
    private var checkWaiters: [ExistenceCall: CheckedContinuation<Void, Never>] = [:]
    private var listingFailure = false
    private var checkFailure = false
    private var outside: Set<ExistenceCall> = []

    func holdListing(_ call: ListingCall) { heldListings.insert(call) }
    func holdCheck(_ call: ExistenceCall) { heldChecks.insert(call) }
    func setFailures(listing: Bool, check: Bool = false) {
        listingFailure = listing
        checkFailure = check
    }
    func setOutside(_ call: ExistenceCall) { outside.insert(call) }
    func releaseListing(_ call: ListingCall) {
        heldListings.remove(call)
        listingWaiters.removeValue(forKey: call)?.resume()
    }
    func releaseCheck(_ call: ExistenceCall) {
        heldChecks.remove(call)
        checkWaiters.removeValue(forKey: call)?.resume()
    }

    func listMachineDirectory(machineId: String, path: String, includeHidden: Bool) async throws -> MachineListDirectoryResponse {
        let call = ListingCall(machineId: machineId, path: path, includeHidden: includeHidden)
        listings.append(call)
        let failed = listingFailure
        // Intentionally ignore cancellation to exercise late transport responses.
        if heldListings.contains(call) {
            await withCheckedContinuation { listingWaiters[call] = $0 }
        }
        completedListings.append(call)
        return MachineListDirectoryResponse(
            success: !failed,
            entries: ["github", "gists", ".git", "other"]
                .filter { includeHidden || !$0.hasPrefix(".") }
                .map { MachineDirectoryEntry(name: $0, type: .directory) },
            error: failed ? "Listing failed" : nil
        )
    }

    func machinePathsExist(machineId: String, paths: [String]) async throws -> MachinePathsExistsResponse {
        let path = paths[0]
        let call = ExistenceCall(machineId: machineId, path: path)
        checks.append(call)
        let denied = outside.contains(call)
        let failed = checkFailure
        if heldChecks.contains(call) {
            await withCheckedContinuation { checkWaiters[call] = $0 }
        }
        completedChecks.append(call)
        if failed { throw URLError(.timedOut) }
        return MachinePathsExistsResponse(exists: [path: false], outsideWorkspaceRoots: denied ? [path] : nil)
    }
}

private func directoryMachine(_ id: String = "m1", roots: [String]? = nil, home: String = "/home/dev") -> Machine {
    Machine(
        id: id, namespace: "test", seq: 1, createdAt: 0, updatedAt: 0,
        active: true, activeAt: 0,
        metadata: MachineMetadata(host: id, platform: "linux", happyCliVersion: "test", homeDir: home, workspaceRoots: roots),
        metadataVersion: 1, runnerStateVersion: 0
    )
}

@MainActor
private func directoryEventually(_ condition: @MainActor () async -> Bool) async -> Bool {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: .seconds(3))
    while clock.now < deadline {
        if await condition() { return true }
        try? await Task.sleep(for: .milliseconds(2))
    }
    return await condition()
}

@Suite("NewSessionDirectoryModel")
@MainActor
struct NewSessionDirectoryModelTests {
    @Test func completesOutsideHomeAndRefiltersCacheWhileClearingOldSuggestionsImmediately() async {
        let requester = DirectoryRequester()
        let model = NewSessionDirectoryModel(requester: requester, debounce: .milliseconds(10))
        model.update(machine: directoryMachine(), path: "/data/gi", showSuggestions: true)
        #expect(await directoryEventually { model.lookupState == .loaded })
        #expect(model.suggestions == ["/data/github", "/data/gists"])
        #expect(await requester.listings == [ListingCall(machineId: "m1", path: "/data")])
        model.update(machine: directoryMachine(), path: "/data/gith", showSuggestions: true)
        #expect(model.suggestions == ["/data/github"])
        #expect(await requester.listings.count == 1)
        model.update(machine: directoryMachine(), path: "/elsewhere/g", showSuggestions: true)
        #expect(model.suggestions.isEmpty)
        #expect(model.lookupState == .loading)
        model.update(machine: directoryMachine(), path: "", showSuggestions: true)
        #expect(model.lookupState == .idle)
        #expect(model.exists == nil)
        #expect(!model.isCheckingExistence)
        model.stop()
    }

    @Test func knownRootsCompleteWithoutListingTheirAncestors() async {
        let requester = DirectoryRequester()
        let model = NewSessionDirectoryModel(requester: requester, debounce: .zero)
        let machine = directoryMachine(roots: ["/data/github", "/work"])
        model.update(machine: machine, path: "/data/gi", showSuggestions: true)
        #expect(model.suggestions == ["/data/github"])
        #expect(await requester.listings.isEmpty)
        model.update(machine: machine, path: "/data/github", showSuggestions: true)
        #expect(await directoryEventually { model.lookupState == .loaded })
        #expect(await requester.listings == [ListingCall(machineId: "m1", path: "/data/github")])
        model.update(machine: machine, path: "/unrelated/g", showSuggestions: true)
        #expect(model.lookupState == .outsideRoots)
        #expect(model.suggestions.isEmpty)
        model.stop()
    }

    @Test func dotPrefixUsesASeparateHiddenDirectoryCache() async {
        let requester = DirectoryRequester()
        let model = NewSessionDirectoryModel(requester: requester, debounce: .zero)
        model.update(machine: directoryMachine(), path: "/data/g", showSuggestions: true)
        #expect(await directoryEventually { model.lookupState == .loaded })
        model.update(machine: directoryMachine(), path: "/data/.", showSuggestions: true)
        #expect(await directoryEventually { model.lookupState == .loaded })
        #expect(model.suggestions == ["/data/.git"])
        #expect(await requester.listings.map(\.includeHidden) == [false, true])
        model.update(machine: directoryMachine(), path: "/data/.g", showSuggestions: true)
        #expect(model.suggestions == ["/data/.git"])
        #expect(await requester.listings.count == 2)
        model.stop()
    }

    @Test func slowListingDoesNotBlockExistenceAndCannotReplaceNewInput() async {
        let requester = DirectoryRequester()
        let held = ListingCall(machineId: "m1", path: "/old")
        await requester.holdListing(held)
        let model = NewSessionDirectoryModel(requester: requester, debounce: .zero)
        model.update(machine: directoryMachine(), path: "/old/gi", showSuggestions: true)
        #expect(await directoryEventually { await requester.listings.contains(held) && model.exists == false })
        #expect(model.lookupState == .loading)
        model.update(machine: directoryMachine(), path: "/new/gith", showSuggestions: true)
        #expect(await directoryEventually { model.lookupState == .loaded })
        await requester.releaseListing(held)
        #expect(await directoryEventually { await requester.completedListings.contains(held) })
        #expect(model.suggestions == ["/new/github"])
        model.stop()
    }

    @Test func machineSwitchRejectsOldExistenceAndListingResponses() async {
        let requester = DirectoryRequester()
        let oldListing = ListingCall(machineId: "m1", path: "/data")
        let oldCheck = ExistenceCall(machineId: "m1", path: "/data/gi")
        await requester.holdListing(oldListing)
        await requester.holdCheck(oldCheck)
        await requester.setOutside(ExistenceCall(machineId: "m2", path: "/data/gi"))
        let model = NewSessionDirectoryModel(requester: requester, debounce: .zero)
        model.update(machine: directoryMachine(), path: "/data/gi", showSuggestions: true)
        #expect(await directoryEventually {
            let checks = await requester.checks
            let listings = await requester.listings
            return checks.contains(oldCheck) && listings.contains(oldListing)
        })
        model.update(machine: directoryMachine("m2", roots: ["/work"]), path: "/data/gi", showSuggestions: true)
        #expect(await directoryEventually { model.outsideWorkspaceRoots })
        await requester.releaseListing(oldListing)
        await requester.releaseCheck(oldCheck)
        #expect(await directoryEventually {
            let checks = await requester.completedChecks
            let listings = await requester.completedListings
            return checks.contains(oldCheck) && listings.contains(oldListing)
        })
        #expect(model.outsideWorkspaceRoots)
        #expect(model.lookupState == .outsideRoots)
        #expect(model.suggestions.isEmpty)
        model.stop()
    }

    @Test func listingFailureAndMissingPathAreIndependentAndRetryRefreshesBoth() async {
        let requester = DirectoryRequester()
        await requester.setFailures(listing: true)
        let model = NewSessionDirectoryModel(requester: requester, debounce: .zero)
        model.update(machine: directoryMachine(), path: "/data/gi", showSuggestions: true)
        #expect(await directoryEventually { model.lookupState == .failed("Listing failed") && model.exists == false })
        await requester.setFailures(listing: false, check: true)
        model.retry()
        #expect(await directoryEventually { model.lookupState == .loaded && model.existenceError != nil })
        #expect(model.exists == nil)
        #expect(model.suggestions == ["/data/github", "/data/gists"])
        await requester.setFailures(listing: false)
        model.retry()
        #expect(await directoryEventually { model.exists == false && model.lookupState == .loaded })
        #expect(model.existenceError == nil)
        #expect(await requester.listings.count == 3)
        model.stop()
    }

    @Test func homeExpansionUsesTheRemoteMachineAndPickingSuppressesSuggestions() async {
        let requester = DirectoryRequester()
        let model = NewSessionDirectoryModel(requester: requester, debounce: .zero)
        model.update(machine: directoryMachine(home: "/remote/home"), path: "~/gi", showSuggestions: true)
        #expect(await directoryEventually { model.lookupState == .loaded })
        #expect(model.suggestions == ["/remote/home/github", "/remote/home/gists"])
        #expect(await directoryEventually { await requester.checks.contains(ExistenceCall(machineId: "m1", path: "/remote/home/gi")) })
        model.update(machine: directoryMachine(home: "/remote/home"), path: "~/github", showSuggestions: false)
        #expect(model.suggestions.isEmpty)
        #expect(model.lookupState == .idle)
        model.stop()
    }

    @Test func createRecheckAndClosingSupersedeBackgroundProbes() async {
        let requester = DirectoryRequester()
        let check = ExistenceCall(machineId: "m1", path: "/data/gi")
        await requester.holdCheck(check)
        let model = NewSessionDirectoryModel(requester: requester, debounce: .zero)
        model.update(machine: directoryMachine(), path: check.path, showSuggestions: false)
        #expect(await directoryEventually { await requester.checks.contains(check) })
        model.acceptExistence(MachinePathsExistsResponse(exists: [check.path: true]), machineId: "m1", path: check.path)
        await requester.releaseCheck(check)
        #expect(await directoryEventually { await requester.completedChecks.contains(check) })
        #expect(model.exists == true)
        model.stop()
        #expect(model.exists == nil)
        #expect(model.lookupState == .idle)
    }

    @Test func closingRejectsLateListingsAndSameMachineRootChangesInvalidateCache() async {
        let requester = DirectoryRequester()
        let model = NewSessionDirectoryModel(requester: requester, debounce: .zero)
        model.update(machine: directoryMachine(), path: "/data/gi", showSuggestions: true)
        #expect(await directoryEventually { model.lookupState == .loaded })
        model.update(machine: directoryMachine(roots: ["/work"]), path: "/data/gi", showSuggestions: true)
        #expect(model.lookupState == .outsideRoots)
        #expect(model.suggestions.isEmpty)

        let held = ListingCall(machineId: "m1", path: "/work")
        await requester.holdListing(held)
        model.update(machine: directoryMachine(roots: ["/work"]), path: "/work/gi", showSuggestions: true)
        #expect(await directoryEventually { await requester.listings.contains(held) })
        model.stop()
        await requester.releaseListing(held)
        #expect(await directoryEventually { await requester.completedListings.contains(held) })
        #expect(model.lookupState == .idle)
        #expect(model.suggestions.isEmpty)
        #expect(!model.isCheckingExistence)
    }
}
