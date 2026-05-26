import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import { endpointCatalog } from './plugin-api-docs/endpointCatalog'
import {
    renderAdminApiPage,
    renderSchemasIndex,
    schemaPublicPath,
    type JsonSchema,
    type SchemaRenderInput
} from './plugin-api-docs/renderMarkdown'
import { renderOpenApi } from './plugin-api-docs/renderOpenApi'
import { schemaCatalog } from './plugin-api-docs/schemaCatalog'

const checkMode = process.argv.includes('--check')
const root = process.cwd()
const referenceRoot = join(root, 'docs/reference/plugin-api')
const publicRoot = join(root, 'docs/public/plugin-api')

const obsoleteTopLevelPages = [
    'admin-rest-api.md',
    'agent-extensions.md',
    'hub-runtime.md',
    'runner-runtime.md',
    'runtime-sdk.md',
    'tutorial.md',
    'tutorial-hub-notification.md',
    'tutorial-runner-env.md',
    'tutorial-web-descriptor.md'
]

const obsoleteReferenceDirs = [
    join(referenceRoot, 'schemas')
]

type GeneratedFile = {
    path: string
    content: string
}

async function main(): Promise<void> {
    const files = generateFiles()
    if (checkMode) {
        const committedFiles = files.filter((file) => !isUnderDirectory(file.path, publicRoot))
        const stale = [
            ...await findStaleFiles(committedFiles),
            ...await findObsoleteReferenceFiles()
        ]
        if (stale.length > 0) {
            console.error('Plugin API docs are stale. Run: bun run docs:plugin-api')
            for (const file of stale) {
                console.error(` - ${relative(root, file)}`)
            }
            process.exit(1)
        }
        console.log(`Plugin API docs are up to date (${committedFiles.length} committed files; public artifacts are generated at build time).`)
        return
    }

    await removeObsoleteReferenceFiles()
    await rm(publicRoot, { recursive: true, force: true })
    for (const file of files) {
        await mkdir(dirname(file.path), { recursive: true })
        await writeFile(file.path, file.content, 'utf8')
    }
    console.log(`Generated plugin API docs (${files.length} files).`)
}

function generateFiles(): GeneratedFile[] {
    const jsonSchemas = new Map<string, JsonSchema>()
    const inputs: SchemaRenderInput[] = schemaCatalog.map((doc) => {
        const jsonSchema = z.toJSONSchema(doc.schema, { name: doc.title }) as JsonSchema
        jsonSchemas.set(doc.id, jsonSchema)
        return {
            doc,
            jsonSchema,
            publicPath: schemaPublicPath(doc.id)
        }
    })
    const openApi = renderOpenApi({ endpoints: endpointCatalog, schemaDocs: schemaCatalog, jsonSchemas })
    const markdownFiles = new Map<string, string>([
        ['admin-api.md', renderAdminApiPage(endpointCatalog)],
        ['schemas.md', renderSchemasIndex(inputs)]
    ])

    const files: GeneratedFile[] = []
    for (const [name, content] of markdownFiles) {
        files.push({ path: join(referenceRoot, name), content: ensureTrailingNewline(content) })
    }
    for (const [id, jsonSchema] of jsonSchemas) {
        files.push({
            path: join(publicRoot, 'schemas', `${id}.schema.json`),
            content: `${JSON.stringify(jsonSchema, null, 4)}\n`
        })
    }
    files.push({
        path: join(publicRoot, 'openapi.json'),
        content: `${JSON.stringify(openApi, null, 4)}\n`
    })
    return files.sort((left, right) => left.path.localeCompare(right.path))
}

async function findStaleFiles(files: GeneratedFile[]): Promise<string[]> {
    const stale: string[] = []
    for (const file of files) {
        const current = await readFile(file.path, 'utf8').catch(() => null)
        if (current !== file.content) {
            stale.push(file.path)
        }
    }
    return stale
}

async function findObsoleteReferenceFiles(): Promise<string[]> {
    const obsolete: string[] = []
    for (const page of obsoleteTopLevelPages) {
        const path = join(referenceRoot, page)
        if (await fileExists(path)) {
            obsolete.push(path)
        }
    }
    for (const dir of obsoleteReferenceDirs) {
        obsolete.push(...await listFiles(dir))
    }
    return obsolete.sort((left, right) => left.localeCompare(right))
}

async function removeObsoleteReferenceFiles(): Promise<void> {
    for (const page of obsoleteTopLevelPages) {
        await rm(join(referenceRoot, page), { force: true })
    }
    for (const dir of obsoleteReferenceDirs) {
        await rm(dir, { recursive: true, force: true })
    }
}

async function listFiles(path: string): Promise<string[]> {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => [])
    const files: string[] = []
    for (const entry of entries) {
        const entryPath = join(path, entry.name)
        if (entry.isDirectory()) {
            files.push(...await listFiles(entryPath))
        } else if (entry.isFile()) {
            files.push(entryPath)
        }
    }
    return files
}

async function fileExists(path: string): Promise<boolean> {
    return (await readFile(path).then(() => true).catch(() => false))
}

function ensureTrailingNewline(value: string): string {
    return value.endsWith('\n') ? value : `${value}\n`
}

function isUnderDirectory(path: string, directory: string): boolean {
    const relativePath = relative(directory, path)
    return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
}

await main()
