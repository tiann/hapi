/**
 * Maximum decoded bytes accepted for bounded inline attachment reads
 * (`readBoundedAttachmentFile`, `dshPromptContent`, `runPi`) and legacy
 * single-RPC `uploadFile`. Chunked streaming uploads use
 * `resolveMaxUploadBytes(process.env.HAPI_MAX_UPLOAD_BYTES)` from `@hapi/protocol/apiTypes`.
 */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
