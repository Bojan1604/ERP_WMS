#!/usr/bin/env bash
# Nadogradnja na novu verziju: kopija baze, nova verzija s GitHuba, ponovna izgradnja.
set -euo pipefail
cd "$(dirname "$0")"
bash backup.sh
git -C .. pull --ff-only
docker compose up -d --build
docker image prune -f >/dev/null
echo "Nadograđeno. Provjera: docker compose ps  i  docker compose logs --tail=50 app"
