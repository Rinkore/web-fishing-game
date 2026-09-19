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

# Wiki 存储依赖 Node 内置 node:sqlite（Node >= 22.13），基础镜像不满足时直接构建失败。
RUN node -e "const v=process.versions.node.split('.').map(Number); if(v[0]<22||(v[0]===22&&v[1]<13)){console.error('Wiki 需要 Node >= 22.13，当前 '+process.versions.node);process.exit(1)} const s=require('node:sqlite'); new s.DatabaseSync(':memory:').close();"

# /data 是唯一可写目录，用于 wiki.db（SQLite）、config.json 等测试数据；
# 旧版 wiki.json / wiki-guides.json 只在首次启动迁移时读取，保留作备份。
# Wiki 存储使用 Node 内置 node:sqlite，基础镜像必须 >= Node 22.13。
# 使用数字 UID/GID，兼容官方 node 镜像和本地已有 Node 运行时镜像。
RUN mkdir -p /data && chown -R 1000:1000 /data

USER 1000:1000
EXPOSE 9000
VOLUME ["/data"]

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:9000/api/version').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "--disable-warning=ExperimentalWarning", "backend/server.js"]
