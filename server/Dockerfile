FROM oven/bun:1.3.5 AS deps

WORKDIR /home/bun/app

COPY bun.lock package.json tsconfig.base.json ./
COPY cli/package.json ./cli/package.json
COPY server/package.json ./server/package.json
COPY web/package.json ./web/package.json
COPY website/package.json ./website/package.json
COPY docs/package.json ./docs/package.json

RUN bun install --frozen-lockfile


FROM deps AS build

COPY cli ./cli
COPY server ./server
COPY web ./web

RUN bun run build:single-exe \
    && mkdir -p /out \
    && cp cli/dist-exe/bun-linux-*/hapi /out/hapi


FROM oven/bun:1.3.5-slim AS runtime

WORKDIR /home/bun/app

ENV NODE_ENV=production
ENV WEBAPP_PORT=3006
ENV HAPI_HOME=/data

USER root
RUN mkdir -p /data && chown bun:bun /data
USER bun

VOLUME /data

EXPOSE 3006

COPY --from=build /out/hapi ./hapi

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:' + (process.env.WEBAPP_PORT ?? '3006') + '/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["./hapi", "server"]
