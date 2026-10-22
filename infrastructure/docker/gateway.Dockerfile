# Reverse proxy: / -> web; /api, /mcp, /oauth and /.well-known/oauth-* -> api. TLS is terminated upstream (cloudflared/Caddy/etc).
FROM nginx:1.31-alpine
COPY infrastructure/docker/nginx-base.conf /etc/nginx/nginx.conf
COPY infrastructure/docker/gateway.conf /etc/nginx/conf.d/default.conf
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
