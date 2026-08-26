package app.hapi.protocol.wire

/**
 * Hub protocol schema version this client is built against.
 *
 * Bumped only when the hub wire contract (`docs/api/client-contract/`) makes an
 * incompatible change. Conformance fixtures under `shared/fixtures/` are
 * generated against a specific version; a mismatch turns the protocol test
 * suite red before any UI code is touched.
 */
const val SUPPORTED_PROTOCOL_VERSION: Int = 1
