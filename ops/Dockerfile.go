# Build and runtime image for the settlement daemon (Go).
# Build context is the repo root (see ops/docker-compose.yml: context: ..).
# Binary entrypoint matches the compose command ["./settlement", "daemon"].
FROM docker.io/golang:1.24-alpine AS build
WORKDIR /src
COPY apps/settlement/go.mod apps/settlement/go.sum ./
RUN go mod download
COPY apps/settlement/ .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /settlement ./cmd/settlement

FROM docker.io/alpine:3.20
RUN adduser -D -u 1000 app
WORKDIR /app
COPY --from=build /settlement /app/settlement
USER app
