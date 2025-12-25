FROM oven/bun:1 AS deps

WORKDIR /app

COPY bun.lock package.json tsconfig.base.json ./
COPY cli/package.json ./cli/package.json
COPY server/package.json ./server/package.json
COPY web/package.json ./web/package.json

RUN bun install --frozen-lockfile


FROM deps AS build

COPY server ./server
COPY web ./web

RUN bun run build:web
RUN bun run build:server


FROM oven/bun:1 AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV WEBAPP_PORT=3006
ENV HAPI_HOME=/data

EXPOSE 3006

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:' + (process.env.WEBAPP_PORT ?? '3006') + '/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "server/dist/index.js"]
