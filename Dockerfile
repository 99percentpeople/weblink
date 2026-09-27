FROM oven/bun:1.4.2 AS base

WORKDIR /app

FROM base AS install
COPY package.json bun.lock bunfig.toml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY packages/platform/package.json packages/platform/package.json
COPY servers/weblink-ws-server/package.json servers/weblink-ws-server/package.json
COPY servers/weblink-ws-worker/package.json servers/weblink-ws-worker/package.json
RUN HUSKY=0 bun install --frozen-lockfile --filter weblink-workspace --filter @weblink/web

FROM base AS build
COPY --from=install /app/ ./
COPY . .

ARG VITE_WEBSOCKET_URL
ARG VITE_STUN_SERVERS
ARG VITE_TURN_SERVERS

RUN bun run build

FROM nginx:alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

COPY docker/nginx.conf.template /etc/nginx/nginx.conf.template
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 80 443

ENTRYPOINT ["entrypoint.sh"]
