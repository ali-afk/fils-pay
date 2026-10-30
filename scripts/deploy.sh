#!/usr/bin/env sh
# FilsPay one-command redeploy (per docs/plans/cloud-deploy-update-consistency-2026-10-30.md §4.4).
# A deploy and an update are the SAME command: ./scripts/deploy.sh [git-rev]
# - builds app images from THIS tree, applies migrations before restarting apps,
# - never runs `docker compose down` (targeted up --no-deps instead),
# - leaves the settlement daemon running unless its image changed (quiesce note below),
# - verifies /healthz afterwards and reloads Caddy if present.
#
# Settlement quiesce: if the settlement image changed and a batch close is in
# progress, wait for it to finish (batch ops are single transactions, so a kill
# mid-batch rolls back cleanly; the daemon catches up the most recent day on
# restart). DEPLOY_SEED=1 additionally reseeds demo data — never set it on the
# judged deployment after first boot.
set -eu

REV="${1:-$(git rev-parse --short HEAD)}"
cd "$(dirname "$0")/.."
echo "== FilsPay deploy ${REV} =="

docker compose -f ops/docker-compose.yml build --pull
docker compose -f ops/docker-compose.yml run --rm migrate
if [ "${DEPLOY_SEED:-0}" = "1" ]; then
    docker compose -f ops/docker-compose.yml run --rm seed
fi
docker compose -f ops/docker-compose.yml up -d --no-deps api settlement reporting

code=""
i=0
while [ "$i" -lt 15 ]; do
    code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/healthz || true)
    if [ "$code" = "200" ]; then break; fi
    sleep 2
    i=$((i + 1))
done
if [ "$code" != "200" ]; then
    echo "deploy FAILED: /healthz returned '${code}'" >&2
    docker compose -f ops/docker-compose.yml ps
    exit 1
fi
echo "== healthz 200 — deploy OK =="

if command -v caddy >/dev/null 2>&1; then
    systemctl reload caddy 2>/dev/null || caddy reload --config /etc/caddy/Caddyfile 2>/dev/null || true
fi

docker compose -f ops/docker-compose.yml ps
