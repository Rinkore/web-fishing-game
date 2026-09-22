# Go-only Wiki/game integration image. The Wiki API is served by the same Go
# process as the game API and stores content in PostgreSQL.
ARG GO_IMAGE=golang:1.27.1-bookworm
FROM ${GO_IMAGE} AS build
WORKDIR /src
COPY server-go/go.mod server-go/go.sum ./server-go/
RUN cd server-go && go mod download
COPY server-go ./server-go
RUN cd server-go && CGO_ENABLED=0 go build -trimpath -o /out/game ./cmd/game && \
    CGO_ENABLED=0 go build -trimpath -o /out/migrate ./cmd/migrate && \
    CGO_ENABLED=0 go build -trimpath -o /out/catalog ./cmd/catalog && \
    CGO_ENABLED=0 go build -trimpath -o /out/admin ./cmd/admin

FROM debian:bookworm-slim
ENV FISHING_GO_LISTEN=0.0.0.0:9000 \
    FISHING_GO_FRONTEND_DIR=/app/frontend \
    FISHING_GO_TIMEZONE=Asia/Shanghai
WORKDIR /app
COPY --from=build /out/game /usr/local/bin/game
COPY --from=build /out/migrate /usr/local/bin/migrate
COPY --from=build /out/catalog /usr/local/bin/catalog
COPY --from=build /out/admin /usr/local/bin/admin
COPY frontend ./frontend
COPY docker/wiki-test/entrypoint.sh /usr/local/bin/wiki-test-entrypoint
RUN chmod 0755 /usr/local/bin/game /usr/local/bin/migrate /usr/local/bin/catalog /usr/local/bin/admin /usr/local/bin/wiki-test-entrypoint
EXPOSE 9000
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD ["/bin/bash", "-c", "</dev/tcp/127.0.0.1/9000"]
ENTRYPOINT ["/usr/local/bin/wiki-test-entrypoint"]
