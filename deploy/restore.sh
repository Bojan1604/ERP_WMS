#!/usr/bin/env bash
# Vraćanje baze iz kopije (pg_dump -Fc):  bash restore.sh backups/erp-2026-09-24-0230.dump
# Također za prijenos s lokalnog računala (vidi upute). SVI TRENUTNI PODACI NA POSLUŽITELJU SE BRIŠU.
set -euo pipefail
cd "$(dirname "$0")"
f="${1:?Navedite datoteku kopije}"
[ -f "$f" ] || { echo "Nema datoteke $f"; exit 1; }
read -rp "Obrisati trenutnu bazu na poslužitelju i vratiti $f? Upišite DA: " ok
[ "$ok" = "DA" ] || { echo "Odustano."; exit 1; }
docker compose stop app
docker compose exec -T db psql -U erp -d postgres -c "DROP DATABASE IF EXISTS erp WITH (FORCE);" -c "CREATE DATABASE erp OWNER erp;"
docker compose exec -T db pg_restore -U erp -d erp --no-owner --role=erp < "$f"
docker compose start app
echo "Vraćeno. Program primjenjuje nove migracije pri pokretanju (docker compose logs -f app)."
