#!/usr/bin/env bash
# Brisanje SVIH podataka (npr. nakon probnog rada u testnom okruženju, prije produkcije).
# Prije brisanja radi kopiju. Nakon toga: prvi administrator ili vraćanje kopije (upute).
set -euo pipefail
cd "$(dirname "$0")"
read -rp "Obrisati SVE podatke programa na ovom poslužitelju? Upišite OBRIŠI: " ok
[ "$ok" = "OBRIŠI" ] || { echo "Odustano."; exit 1; }
bash backup.sh
docker compose stop app
docker compose exec -T db psql -U erp -d postgres -c "DROP DATABASE IF EXISTS erp WITH (FORCE);" -c "CREATE DATABASE erp OWNER erp;"
docker compose start app
echo "Baza je prazna (kopija prije brisanja je u deploy/backups). Sljedeće: prvi administrator — vidi upute."
