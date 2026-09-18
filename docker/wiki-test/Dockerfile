# 专门用于本地 Wiki / 攻略投稿链路测试的轻量运行时。
# 默认使用官方 Node Alpine；如果本机已有其他含 Node 的基础镜像，
# 可通过 compose 的 NODE_IMAGE build arg 覆盖，便于离线/镜像受限环境复用。
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE}

ARG SOURCE_COMMIT=0000000000000000000000000000000000000000
ENV NODE_ENV=production \
    PORT=9000 \
    BIND_HOST=0.0.0.0 \
    FISHING_DATA_DIR=/data \
    SOURCE_COMMIT=${SOURCE_COMMIT}

WORKDIR /app
COPY package.json ./package.json
COPY backend ./backend
COPY frontend ./frontend

# /data 是唯一可写目录，用于 wiki.json、wiki-guides.json、config.json 等测试数据。
# 使用数字 UID/GID，兼容官方 node 镜像和本地已有 Node 运行时镜像。
RUN mkdir -p /data && chown -R 1000:1000 /data

USER 1000:1000
EXPOSE 9000
VOLUME ["/data"]

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:9000/api/version').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "backend/server.js"]
