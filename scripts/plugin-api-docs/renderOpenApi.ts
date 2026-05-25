import type { EndpointDoc, EndpointQueryParamDoc } from './endpointCatalog'
import type { JsonSchema } from './renderMarkdown'
import type { SchemaDoc } from './schemaCatalog'

export function renderOpenApi(args: {
    endpoints: EndpointDoc[]
    schemaDocs: SchemaDoc[]
    jsonSchemas: Map<string, JsonSchema>
}): Record<string, unknown> {
    const components: Record<string, unknown> = {}
    for (const doc of args.schemaDocs) {
        const schema = args.jsonSchemas.get(doc.id)
        if (schema) {
            const { $schema: _schema, ...rest } = schema
            components[doc.title] = rest
        }
    }

    const paths: Record<string, Record<string, unknown>> = {}
    for (const endpoint of args.endpoints) {
        const path = endpoint.path
        const method = endpoint.method.toLowerCase()
        paths[path] ??= {}
        paths[path]![method] = renderOperation(endpoint)
    }

    return {
        openapi: '3.1.0',
        info: {
            title: 'HAPI Plugin Admin API',
            version: '0.1.0'
        },
        paths,
        components: {
            securitySchemes: {
                bearerAuth: {
                    type: 'http',
                    scheme: 'bearer'
                }
            },
            schemas: components
        },
        security: [{ bearerAuth: [] }]
    }
}

function renderOperation(endpoint: EndpointDoc): Record<string, unknown> {
    const parameters: Record<string, unknown>[] = []
    for (const name of pathParamNames(endpoint.path)) {
        parameters.push({
            name,
            in: 'path',
            required: true,
            schema: { type: 'string', minLength: 1 }
        })
    }
    for (const query of queryParams(endpoint)) {
        parameters.push(renderQueryParam(query))
    }

    return {
        operationId: endpoint.id,
        summary: endpoint.description,
        parameters,
        ...(endpoint.bodySchema ? {
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: { $ref: `#/components/schemas/${endpoint.bodySchema}` }
                    }
                }
            }
        } : {}),
        responses: {
            '200': {
                description: 'OK',
                content: {
                    'application/json': {
                        schema: { $ref: `#/components/schemas/${endpoint.responseSchema}` }
                    }
                }
            },
            '400': { description: 'Invalid request' },
            '401': { description: 'Unauthorized' },
            '404': { description: 'Not found' },
            '409': { description: 'Conflict' },
            '500': { description: 'Server error' }
        }
    }
}

function pathParamNames(path: string): string[] {
    return Array.from(path.matchAll(/\{([^}]+)\}/g), (match) => match[1]!).filter(Boolean)
}

function queryParams(endpoint: EndpointDoc): EndpointQueryParamDoc[] {
    return [
        ...(endpoint.targetQuery ? [{
            name: 'target',
            description: 'Plugin target scope.',
            schemaRef: 'PluginTargetScope'
        }] : []),
        ...(endpoint.queryParams ?? [])
    ]
}

function renderQueryParam(query: EndpointQueryParamDoc): Record<string, unknown> {
    return {
        name: query.name,
        in: 'query',
        required: query.required === true,
        description: query.description,
        schema: query.schemaRef ? { $ref: `#/components/schemas/${query.schemaRef}` } : query.schema ?? { type: 'string' }
    }
}
