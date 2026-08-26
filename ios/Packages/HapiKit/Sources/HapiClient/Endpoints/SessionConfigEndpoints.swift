import Foundation
import HapiProtocol

/// Per-flavor session configuration (`docs/api/client-contract/rest.md`).
/// Wrong-flavor calls answer 400 (hide the control); remote-only controls
/// answer 409 while the session is terminal-controlled. All respond
/// `{ok: true}`.
///
/// The nullable bodies (`model`, `effort`, `modelReasoningEffort`,
/// `serviceTier`) encode an **explicit JSON null** when the value is absent —
/// "reset to default" — matching the reference client's `JSON.stringify`
/// output; an omitted key would fail the hub's schema.
extension APIClient {
    /// `POST /api/sessions/:id/permission-mode`.
    public func setPermissionMode(sessionId: String, mode: PermissionMode) async throws {
        struct PermissionModeRequest: Encodable {
            let mode: PermissionMode
        }
        try await requestVoid(
            .post,
            "/api/sessions/\(encodePathComponent(sessionId))/permission-mode",
            body: PermissionModeRequest(mode: mode)
        )
    }

    /// `POST /api/sessions/:id/model` (`nil` resets to the default model).
    public func setModel(sessionId: String, model: ModelSelection?) async throws {
        struct SetModelRequest: Encodable {
            let model: ModelSelection?

            enum CodingKeys: String, CodingKey {
                case model
            }

            func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                if let model {
                    try container.encode(model, forKey: .model)
                } else {
                    try container.encodeNil(forKey: .model)
                }
            }
        }
        try await requestVoid(
            .post,
            "/api/sessions/\(encodePathComponent(sessionId))/model",
            body: SetModelRequest(model: model)
        )
    }

    /// `POST /api/sessions/:id/effort` — claude, grok, pi.
    public func setEffort(sessionId: String, effort: String?) async throws {
        struct SetEffortRequest: Encodable {
            let effort: String?

            enum CodingKeys: String, CodingKey {
                case effort
            }

            func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                if let effort {
                    try container.encode(effort, forKey: .effort)
                } else {
                    try container.encodeNil(forKey: .effort)
                }
            }
        }
        try await requestVoid(
            .post,
            "/api/sessions/\(encodePathComponent(sessionId))/effort",
            body: SetEffortRequest(effort: effort)
        )
    }

    /// `POST /api/sessions/:id/model-reasoning-effort` — codex, opencode
    /// (remote-only).
    public func setModelReasoningEffort(sessionId: String, modelReasoningEffort: String?) async throws {
        struct SetModelReasoningEffortRequest: Encodable {
            let modelReasoningEffort: String?

            enum CodingKeys: String, CodingKey {
                case modelReasoningEffort
            }

            func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                if let modelReasoningEffort {
                    try container.encode(modelReasoningEffort, forKey: .modelReasoningEffort)
                } else {
                    try container.encodeNil(forKey: .modelReasoningEffort)
                }
            }
        }
        try await requestVoid(
            .post,
            "/api/sessions/\(encodePathComponent(sessionId))/model-reasoning-effort",
            body: SetModelReasoningEffortRequest(modelReasoningEffort: modelReasoningEffort)
        )
    }

    /// `POST /api/sessions/:id/service-tier` — codex (remote-only).
    public func setServiceTier(sessionId: String, serviceTier: ServiceTier?) async throws {
        struct SetServiceTierRequest: Encodable {
            let serviceTier: ServiceTier?

            enum CodingKeys: String, CodingKey {
                case serviceTier
            }

            func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                if let serviceTier {
                    try container.encode(serviceTier, forKey: .serviceTier)
                } else {
                    try container.encodeNil(forKey: .serviceTier)
                }
            }
        }
        try await requestVoid(
            .post,
            "/api/sessions/\(encodePathComponent(sessionId))/service-tier",
            body: SetServiceTierRequest(serviceTier: serviceTier)
        )
    }

    /// `POST /api/sessions/:id/collaboration-mode` — codex (remote-only).
    public func setCollaborationMode(sessionId: String, mode: CodexCollaborationMode) async throws {
        struct CollaborationModeRequest: Encodable {
            let mode: CodexCollaborationMode
        }
        try await requestVoid(
            .post,
            "/api/sessions/\(encodePathComponent(sessionId))/collaboration-mode",
            body: CollaborationModeRequest(mode: mode)
        )
    }

    /// `POST /api/sessions/:id/copilot-agent-mode` — copilot (remote-only).
    public func setCopilotAgentMode(sessionId: String, mode: CopilotAgentMode) async throws {
        struct CopilotAgentModeRequest: Encodable {
            let mode: CopilotAgentMode
        }
        try await requestVoid(
            .post,
            "/api/sessions/\(encodePathComponent(sessionId))/copilot-agent-mode",
            body: CopilotAgentModeRequest(mode: mode)
        )
    }
}
