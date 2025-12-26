FROM oven/bun:1.3.4 AS deps

WORKDIR /home/bun/app

COPY bun.lock package.json tsconfig.base.json ./
COPY cli/package.json ./cli/package.json
COPY server/package.json ./server/package.json
COPY web/package.json ./web/package.json

RUN bun install --frozen-lockfile


FROM deps AS build

# Build web assets first to improve caching
COPY web ./web
RUN bun run build:web

# Then build server
COPY server ./server

# Embed built web assets into the compiled server executable
RUN cd server && bun run generate:embedded-web-assets
RUN bun build server/src/index.ts --compile --outfile server/dist/hapi-server


FROM oven/bun:1.3.4-slim AS runtime

WORKDIR /home/bun/app

ENV NODE_ENV=production
ENV WEBAPP_PORT=3006
ENV HAPI_HOME=/data

USER root
RUN mkdir -p /data && chown bun:bun /data
USER bun

VOLUME /data

EXPOSE 3006

COPY --from=build /home/bun/app/server/dist/hapi-server ./server/hapi-server

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:' + (process.env.WEBAPP_PORT ?? '3006') + '/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["./server/hapi-server"]
