import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { endpointCatalog, type EndpointDoc } from './plugin-api-docs/endpointCatalog'
import { schemaCatalog } from './plugin-api-docs/schemaCatalog'

const root = process.cwd()
const routeFiles = [
    // Add every file that registers /api/plugins* routes here; duplicate method/path pairs are rejected below.
    'hub/src/web/routes/plugins.ts',
    'hub/src/plugins/admin/installMarketplaceRoutes.ts'
]

function main(): void {
    const errors = [
        ...checkRouteCoverage(),
        ...checkRouteDuplicates(),
        ...checkEndpointSchemaRefs(),
        ...checkSchemaCatalogUniqueness()
    ]
    if (errors.length > 0) {
        console.error('[plugin-api-docs:check] failed')
        for (const error of errors) {
            console.error(` - ${error}`)
        }
        process.exit(1)
    }
    console.log('[plugin-api-docs:check] OK')
}

function checkRouteCoverage(): string[] {
    const actual = routeFiles.flatMap((routeFile) => extractPluginRoutes(readFileSync(routeFile, 'utf8')))
    const documented = endpointCatalog.map((endpoint) => `${endpoint.method} ${endpoint.path}`).sort()
    const actualSet = new Set(actual)
    const documentedSet = new Set(documented)
    const errors: string[] = []
    for (const route of actual) {
        if (!documentedSet.has(route)) {
            errors.push(`Route exists but is missing from endpointCatalog: ${route}`)
        }
    }
    for (const route of documented) {
        if (!actualSet.has(route)) {
            errors.push(`endpointCatalog documents a route not found in plugin route files (${routeFiles.map((file) => relative(root, file)).join(', ')}): ${route}`)
        }
    }
    return errors
}

function checkRouteDuplicates(): string[] {
    const seen = new Map<string, string>()
    const errors: string[] = []
    for (const routeFile of routeFiles) {
        for (const route of extractPluginRoutes(readFileSync(routeFile, 'utf8'))) {
            const existing = seen.get(route)
            if (existing) {
                errors.push(`Duplicate plugin route ${route} in ${relative(root, existing)} and ${relative(root, routeFile)}`)
                continue
            }
            seen.set(route, routeFile)
        }
    }
    return errors
}

function extractPluginRoutes(source: string): string[] {
    const routes: string[] = []
    const matcher = /app\.(get|post|patch|delete)\('([^']+)'/g
    for (const match of source.matchAll(matcher)) {
        const method = match[1]!.toUpperCase()
        const route = match[2]!
        routes.push(`${method} /api${route.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`)
    }
    return routes.sort()
}

function checkEndpointSchemaRefs(): string[] {
    const schemas = new Set(schemaCatalog.map((doc) => doc.title))
    const errors: string[] = []
    for (const endpoint of endpointCatalog) {
        for (const ref of endpointSchemaRefs(endpoint)) {
            if (!schemas.has(ref)) {
                errors.push(`${endpoint.id} references schema ${ref}, but schemaCatalog does not include it`)
            }
        }
    }
    return errors
}

function endpointSchemaRefs(endpoint: EndpointDoc): string[] {
    return [
        endpoint.bodySchema,
        endpoint.responseSchema,
        ...(endpoint.targetQuery ? ['PluginTargetScope'] : []),
        ...(endpoint.queryParams ?? []).map((param) => param.schemaRef)
    ].filter((entry): entry is string => Boolean(entry))
}

function checkSchemaCatalogUniqueness(): string[] {
    const errors: string[] = []
    for (const key of ['id', 'title'] as const) {
        const seen = new Set<string>()
        for (const doc of schemaCatalog) {
            const value = doc[key]
            if (seen.has(value)) {
                errors.push(`schemaCatalog duplicate ${key}: ${value}`)
            }
            seen.add(value)
        }
    }
    return errors
}

main()
