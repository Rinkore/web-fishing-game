ARG FISHING_GO_IMAGE_REGISTRY=docker.io
FROM ${FISHING_GO_IMAGE_REGISTRY}/library/golang:1.27.1-bookworm@sha256:69a7b9788769bec032d238959b61854e9ae87f57be9029ec04e9885fabf99195 AS build
ARG GOPROXY=https://goproxy.cn,direct
WORKDIR /src
COPY server-go/go.mod server-go/go.sum ./
RUN go mod download
COPY server-go/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -o /out/game ./cmd/game \
 && CGO_ENABLED=0 GOOS=linux go build -trimpath -o /out/migrate ./cmd/migrate \
 && CGO_ENABLED=0 GOOS=linux go build -trimpath -o /out/catalog ./cmd/catalog

FROM ${FISHING_GO_IMAGE_REGISTRY}/library/debian:bookworm-slim
RUN groupadd --system fishing && useradd --system --gid fishing --home /app fishing
WORKDIR /app
COPY --from=build /out/game /out/migrate /out/catalog /app/
COPY frontend/ /app/frontend/
USER fishing:fishing
ENV FISHING_GO_LISTEN=0.0.0.0:9000 \
    FISHING_GO_FRONTEND_DIR=/app/frontend \
    FISHING_GO_TIMEZONE=Asia/Shanghai \
    TZ=Asia/Shanghai
EXPOSE 9000
ENTRYPOINT ["/app/game"]
