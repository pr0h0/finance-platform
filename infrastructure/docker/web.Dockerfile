# Web: build the Vite app with Bun, serve static files with unprivileged nginx.
FROM oven/bun:1.4 AS build
WORKDIR /repo
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/ packages/
COPY apps/web/ apps/web/
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
RUN cd apps/web && bun run build

FROM nginx:1.31-alpine
COPY infrastructure/docker/nginx-base.conf /etc/nginx/nginx.conf
COPY infrastructure/docker/web.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
