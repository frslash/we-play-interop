# The only public service. Default-deny: exact paths and methods, a 64 KB body cap, per-source limits, timeouts.
FROM nginx:1.27.3-alpine@sha256:814a8e88df978ade80e584cc5b333144b9372a8e3c98872d07137dbf3b44d0e4
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY common.inc /etc/nginx/conf.d/common.inc
ENV NGINX_ENVSUBST_FILTER=^(VTC_UPSTREAM|VTA_UPSTREAM|MEDIATOR_UPSTREAM)$
EXPOSE 8080
