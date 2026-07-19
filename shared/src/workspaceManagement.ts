import { z } from 'zod'

export const HostEntryTypeSchema = z.enum(['file', 'directory', 'symlink', 'other'])
export type HostEntryType = z.infer<typeof HostEntryTypeSchema>

export const HostFileEntrySchema = z.object({
    name: z.string(),
    path: z.string(),
    type: HostEntryTypeSchema,
    size: z.number().int().nonnegative().optional(),
    modified: z.number().int().nonnegative().optional(),
    hidden: z.boolean(),
    isGitRepo: z.boolean().optional()
})
export type HostFileEntry = z.infer<typeof HostFileEntrySchema>

export const HostListDirectoryRequestSchema = z.object({
    path: z.string().trim().min(1),
    includeHidden: z.boolean().optional().default(false)
})
export type HostListDirectoryRequest = z.infer<typeof HostListDirectoryRequestSchema>

export const HostListDirectoryResponseSchema = z.object({
    success: z.boolean(),
    path: z.string().optional(),
    entries: z.array(HostFileEntrySchema).optional(),
    error: z.string().optional()
})
export type HostListDirectoryResponse = z.infer<typeof HostListDirectoryResponseSchema>

export const HostFilePreviewKindSchema = z.enum(['text', 'image', 'binary'])
export type HostFilePreviewKind = z.infer<typeof HostFilePreviewKindSchema>

export const HostFilePreviewRequestSchema = z.object({
    path: z.string().trim().min(1)
})
export type HostFilePreviewRequest = z.infer<typeof HostFilePreviewRequestSchema>

export const HostFilePreviewResponseSchema = z.object({
    success: z.boolean(),
    path: z.string().optional(),
    name: z.string().optional(),
    kind: HostFilePreviewKindSchema.optional(),
    mimeType: z.string().optional(),
    text: z.string().optional(),
    base64: z.string().optional(),
    size: z.number().int().nonnegative().optional(),
    modified: z.number().int().nonnegative().optional(),
    error: z.string().optional()
})
export type HostFilePreviewResponse = z.infer<typeof HostFilePreviewResponseSchema>

export const HostFileWriteRequestSchema = z.object({
    path: z.string().trim().min(1),
    content: z.string().max(2 * 1024 * 1024),
    expectedModified: z.number().int().nonnegative().optional(),
    expectedSize: z.number().int().nonnegative().optional()
})
export type HostFileWriteRequest = z.infer<typeof HostFileWriteRequestSchema>
export const HostFileWriteResponseSchema = HostFilePreviewResponseSchema
export type HostFileWriteResponse = z.infer<typeof HostFileWriteResponseSchema>

export const HostDownloadPrepareRequestSchema = z.object({
    path: z.string().trim().min(1)
})
export type HostDownloadPrepareRequest = z.infer<typeof HostDownloadPrepareRequestSchema>

export const HostDownloadDescriptorSchema = z.object({
    id: z.string().uuid(),
    name: z.string().min(1),
    mimeType: z.string(),
    size: z.number().int().nonnegative(),
    archive: z.boolean()
})
export type HostDownloadDescriptor = z.infer<typeof HostDownloadDescriptorSchema>

export const HostDownloadPrepareResponseSchema = z.object({
    success: z.boolean(),
    download: HostDownloadDescriptorSchema.optional(),
    error: z.string().optional()
})
export type HostDownloadPrepareResponse = z.infer<typeof HostDownloadPrepareResponseSchema>

export const HostDownloadChunkRequestSchema = z.object({
    id: z.string().uuid(),
    offset: z.number().int().nonnegative()
})
export type HostDownloadChunkRequest = z.infer<typeof HostDownloadChunkRequestSchema>

export const HostDownloadChunkResponseSchema = z.object({
    success: z.boolean(),
    base64: z.string().optional(),
    nextOffset: z.number().int().nonnegative().optional(),
    done: z.boolean().optional(),
    error: z.string().optional()
})
export type HostDownloadChunkResponse = z.infer<typeof HostDownloadChunkResponseSchema>

const HostPathListSchema = z.array(z.string().trim().min(1)).min(1).max(200)
export const HostConflictPolicySchema = z.enum(['fail', 'replace', 'new-copy', 'skip'])
export const MAX_HOST_FILE_UPLOAD_BYTES = 20 * 1024 * 1024
const HostUploadFileNameSchema = z.string().trim().min(1).max(255).refine(
    (value) => value !== '.' && value !== '..' && !/[\\/\0]/.test(value),
    'Invalid file name'
)

export const HostFileUploadRequestSchema = z.object({
    directory: z.string().trim().min(1),
    name: HostUploadFileNameSchema,
    contentBase64: z.string().max(Math.ceil((MAX_HOST_FILE_UPLOAD_BYTES * 4) / 3) + 4),
    conflict: HostConflictPolicySchema.default('new-copy')
})
export type HostFileUploadRequest = z.infer<typeof HostFileUploadRequestSchema>

export const HostFileUploadResponseSchema = z.object({
    success: z.boolean(),
    path: z.string().optional(),
    size: z.number().int().nonnegative().optional(),
    replaced: z.boolean().optional(),
    skipped: z.boolean().optional(),
    error: z.string().optional()
})
export type HostFileUploadResponse = z.infer<typeof HostFileUploadResponseSchema>

export const FileOperationSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('create-file'),
        path: z.string().trim().min(1),
        content: z.string().optional()
    }),
    z.object({
        kind: z.literal('create-directory'),
        path: z.string().trim().min(1)
    }),
    z.object({
        kind: z.literal('copy'),
        sources: HostPathListSchema,
        destination: z.string().trim().min(1),
        conflict: HostConflictPolicySchema.default('fail'),
        createDestination: z.boolean().default(false)
    }),
    z.object({
        kind: z.literal('move'),
        sources: HostPathListSchema,
        destination: z.string().trim().min(1),
        conflict: HostConflictPolicySchema.default('fail'),
        createDestination: z.boolean().default(false)
    }),
    z.object({
        kind: z.literal('delete'),
        paths: HostPathListSchema
    })
])
export type FileOperation = z.input<typeof FileOperationSchema>
export type ParsedFileOperation = z.output<typeof FileOperationSchema>

export const GitFileChangeSchema = z.object({
    path: z.string(),
    oldPath: z.string().optional(),
    indexStatus: z.string(),
    worktreeStatus: z.string()
})
export type GitFileChange = z.infer<typeof GitFileChangeSchema>

export const GitRemoteSchema = z.object({
    name: z.string(),
    fetchUrl: z.string().optional(),
    pushUrl: z.string().optional()
})
export type GitRemote = z.infer<typeof GitRemoteSchema>

export const GitCapabilitiesSchema = z.object({
    gitAvailable: z.boolean(),
    ghAvailable: z.boolean(),
    ghAuthenticated: z.boolean()
})
export type GitCapabilities = z.infer<typeof GitCapabilitiesSchema>

export const GitBranchSchema = z.object({
    name: z.string(),
    remote: z.string().optional(),
    current: z.boolean().optional(),
    upstream: z.string().optional(),
    merged: z.boolean().optional()
})
export type GitBranch = z.infer<typeof GitBranchSchema>

export const GitCommitTemplateSchema = z.enum(['conventional', 'custom'])
export type GitCommitTemplate = z.infer<typeof GitCommitTemplateSchema>

export const RepositorySnapshotSchema = z.object({
    repositoryRoot: z.string(),
    branch: z.string().nullable(),
    upstream: z.string().nullable(),
    ahead: z.number().int().nonnegative(),
    behind: z.number().int().nonnegative(),
    changes: z.array(GitFileChangeSchema),
    remotes: z.array(GitRemoteSchema),
    branches: z.array(GitBranchSchema).default([]),
    commitTemplate: GitCommitTemplateSchema.default('conventional'),
    capabilities: GitCapabilitiesSchema
})
export type RepositorySnapshot = z.infer<typeof RepositorySnapshotSchema>

export const GitInspectRequestSchema = z.object({
    path: z.string().trim().min(1)
})
export type GitInspectRequest = z.infer<typeof GitInspectRequestSchema>

export const GitInspectResponseSchema = z.object({
    success: z.boolean(),
    repository: RepositorySnapshotSchema.optional(),
    capabilities: GitCapabilitiesSchema.optional(),
    error: z.string().optional()
})
export type GitInspectResponse = z.infer<typeof GitInspectResponseSchema>

const GitPathListSchema = z.array(z.string().min(1)).max(500)
const GitRemoteNameSchema = z.string().trim().regex(/^[A-Za-z0-9._-]+$/)
const GitBranchNameSchema = z.string().trim().min(1).max(255).refine(
    (value) => !value.startsWith('-') && !/[\s~^:?*\\[\\]/.test(value) && !value.includes('..') && !value.endsWith('.'),
    'Invalid branch name'
)
export const GitOperationSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('clone'),
        source: z.string().trim().min(1).max(2048),
        destination: z.string().trim().min(1)
    }),
    z.object({
        kind: z.literal('stage'),
        repository: z.string().trim().min(1),
        paths: GitPathListSchema
    }),
    z.object({
        kind: z.literal('unstage'),
        repository: z.string().trim().min(1),
        paths: GitPathListSchema
    }),
    z.object({
        kind: z.literal('commit'),
        repository: z.string().trim().min(1),
        message: z.string().trim().min(1).max(20_000),
        template: GitCommitTemplateSchema.default('custom')
    }),
    z.object({
        kind: z.literal('set-commit-template'),
        repository: z.string().trim().min(1),
        template: GitCommitTemplateSchema
    }),
    z.object({
        kind: z.literal('push'),
        repository: z.string().trim().min(1),
        remote: GitRemoteNameSchema.default('origin'),
        setUpstream: z.boolean().default(false)
    }),
    z.object({
        kind: z.literal('set-remote'),
        repository: z.string().trim().min(1),
        remote: GitRemoteNameSchema.default('origin'),
        url: z.string().trim().min(1).max(2048)
    }),
    z.object({
        kind: z.literal('fetch'),
        repository: z.string().trim().min(1),
        remote: GitRemoteNameSchema.optional()
    }),
    z.object({
        kind: z.literal('update-current'),
        repository: z.string().trim().min(1)
    }),
    z.object({
        kind: z.literal('switch-branch'),
        repository: z.string().trim().min(1),
        name: GitBranchNameSchema
    }),
    z.object({
        kind: z.literal('create-branch'),
        repository: z.string().trim().min(1),
        name: GitBranchNameSchema,
        startPoint: z.string().trim().min(1).max(512).optional(),
        switchTo: z.boolean().default(true)
    }),
    z.object({
        kind: z.literal('delete-branch'),
        repository: z.string().trim().min(1),
        name: GitBranchNameSchema,
        force: z.boolean().default(false)
    }),
    z.object({
        kind: z.literal('delete-remote-branch'),
        repository: z.string().trim().min(1),
        remote: GitRemoteNameSchema.default('origin'),
        name: GitBranchNameSchema
    })
])
export type GitOperation = z.input<typeof GitOperationSchema>
export type ParsedGitOperation = z.output<typeof GitOperationSchema>

export const HostOperationRequestSchema = z.discriminatedUnion('domain', [
    z.object({ domain: z.literal('file'), operation: FileOperationSchema }),
    z.object({ domain: z.literal('git'), operation: GitOperationSchema })
])
export type HostOperationRequest = z.input<typeof HostOperationRequestSchema>
export type ParsedHostOperationRequest = z.output<typeof HostOperationRequestSchema>

export const HostOperationStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled'])
export type HostOperationStatus = z.infer<typeof HostOperationStatusSchema>

export const HostOperationSnapshotSchema = z.object({
    id: z.string().uuid(),
    domain: z.enum(['file', 'git']),
    kind: z.string(),
    status: HostOperationStatusSchema,
    progress: z.number().min(0).max(1),
    message: z.string().optional(),
    result: z.record(z.string(), z.unknown()).optional(),
    error: z.string().optional(),
    createdAt: z.number().int(),
    startedAt: z.number().int().optional(),
    finishedAt: z.number().int().optional()
})
export type HostOperationSnapshot = z.infer<typeof HostOperationSnapshotSchema>

export const HostOperationStartResponseSchema = z.object({
    success: z.boolean(),
    operation: HostOperationSnapshotSchema.optional(),
    error: z.string().optional()
})
export type HostOperationStartResponse = z.infer<typeof HostOperationStartResponseSchema>

export const HostOperationGetRequestSchema = z.object({ id: z.string().uuid() })
export type HostOperationGetRequest = z.infer<typeof HostOperationGetRequestSchema>

export const HostOperationGetResponseSchema = HostOperationStartResponseSchema
export type HostOperationGetResponse = z.infer<typeof HostOperationGetResponseSchema>
