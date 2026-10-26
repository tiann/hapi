import Observation
import SwiftUI

/// User-owned state outlives recycled cells, but not the retained transcript.
@MainActor @Observable
final class ChatPresentationState {
    struct Key: Hashable { let id: String; let field: String }
    var values: [Key: Any] = [:]

    func prune(to ids: Set<String>) {
        for key in values.keys.filter({ !ids.contains($0.id) }) { values.removeValue(forKey: key) }
    }
}

private struct ChatPresentationStateKey: EnvironmentKey {
    static let defaultValue: ChatPresentationState? = nil
}

extension EnvironmentValues {
    var chatPresentationState: ChatPresentationState? {
        get { self[ChatPresentationStateKey.self] }
        set { self[ChatPresentationStateKey.self] = newValue }
    }
}

@MainActor @propertyWrapper
struct ChatStoredState<Value>: DynamicProperty {
    @Environment(\.chatPresentationState) private var store
    @State private var fallback: Value
    private let key: ChatPresentationState.Key

    init(wrappedValue: Value, id: String, field: String) {
        _fallback = State(initialValue: wrappedValue)
        key = .init(id: id, field: field)
    }

    var wrappedValue: Value {
        get { store?.values[key] as? Value ?? fallback }
        nonmutating set {
            if let store { store.values[key] = newValue }
            else { fallback = newValue }
        }
    }

    var projectedValue: Binding<Value> { Binding(get: { wrappedValue }, set: { wrappedValue = $0 }) }
}
