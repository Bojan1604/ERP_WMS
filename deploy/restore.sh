#!/usr/bin/env bash
# Vraćanje baze iz kopije (pg_dump -Fc), po želji i datoteka (MDM, storage/):
#   bash restore.sh backups/erp-2026-09-24-0230.dump [backups/files-2026-09-24-0230.tgz]
# Također za prijenos s lokalnog računala (vidi upute). SVI TRENUTNI PODACI NA POSLUŽITELJU SE BRIŠU.
set -euo pipefail
cd "$(dirname "$0")"
f="${1:?Navedite datoteku kopije}"
files="${2:-}"
[ -f "$f" ] || { echo "Nema datoteke $f"; exit 1; }
[ -z "$files" ] || [ -f "$files" ] || { echo "Nema datoteke $files"; exit 1; }
read -rp "Obrisati trenutnu bazu na poslužitelju i vratiti $f${files:+ i $files}? Upišite DA: " ok
[ "$ok" = "DA" ] || { echo "Odustano."; exit 1; }
docker compose stop app
docker compose exec -T db psql -U erp -d postgres -c "DROP DATABASE IF EXISTS erp WITH (FORCE);" -c "CREATE DATABASE erp OWNER erp;"
docker compose exec -T db pg_restore -U erp -d erp --no-owner --role=erp < "$f"
if [ -n "$files" ]; then
  dir=$(cd "$(dirname "$files")" && pwd)
  docker compose run --rm --no-deps -T -v "$dir:/b:ro" --entrypoint sh app \
    -c "rm -rf /data/mdm/* /app/storage/* && tar xzf /b/$(basename "$files") -C /tmp && cp -a /tmp/mdm/. /data/mdm/ 2>/dev/null; cp -a /tmp/storage/. /app/storage/ 2>/dev/null; true"
fi
docker compose start app
echo "Vraćeno. Program primjenjuje nove migracije pri pokretanju (docker compose logs -f app)."
