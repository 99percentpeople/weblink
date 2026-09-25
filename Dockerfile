FROM oven/bun:1 AS base

WORKDIR /app

FROM base AS install
RUN mkdir -p /temp/prod
COPY package.json bun.lock /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile

FROM base AS build
COPY --from=install /temp/prod/node_modules node_modules
COPY . .

ARG VITE_WEBSOCKET_URL
ARG VITE_STUN_SERVERS
ARG VITE_TURN_SERVERS

RUN bun run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html

COPY docker/nginx.conf.template /etc/nginx/nginx.conf.template
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 80 443

ENTRYPOINT ["entrypoint.sh"]
