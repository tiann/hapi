# HAPI push relay - build with the relay/ directory as context:
#
#   docker build -t hapi-push-relay relay/
#
# The relay has a single runtime dependency (jose), so a fresh install from
# the package manifest is deliberate - no workspace lockfile gymnastics.
FROM oven/bun:1.4.0-slim

WORKDIR /app

COPY package.json ./
RUN bun install --production

COPY src ./src

ENV RELAY_PORT=8790
EXPOSE 8790

# The APNs .p8 key must be mounted read-only and pointed at via env:
#   -v /secrets/AuthKey_XXXXXXXXXX.p8:/keys/apns.p8:ro
#   -e RELAY_APNS_KEY_P8_PATH=/keys/apns.p8
USER bun

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
    CMD ["bun", "-e", "fetch('http://127.0.0.1:'+(process.env.RELAY_PORT||8790)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["bun", "run", "src/index.ts"]
