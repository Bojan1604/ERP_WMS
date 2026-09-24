#!/usr/bin/env bash
# Sigurnosna kopija: baza (svaki dan, čuva se 30 dana) i MDM datoteke (čuva se 7 dana).
# Cron (svaku noć u 2:30):  30 2 * * * /opt/erp/deploy/backup.sh >> /opt/erp/deploy/backups/backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p backups
stamp=$(date +%F-%H%M)
docker compose exec -T db pg_dump -U erp -Fc erp > "backups/erp-$stamp.dump.part"
mv "backups/erp-$stamp.dump.part" "backups/erp-$stamp.dump"
docker compose run --rm --no-deps -T -v "$PWD/backups:/b" --entrypoint sh app -c "tar czf /b/mdm-$stamp.tgz -C /data/mdm ." >/dev/null 2>&1 || true
find backups -name 'erp-*.dump' -mtime +30 -delete
find backups -name 'mdm-*.tgz' -mtime +7 -delete
echo "$(date '+%F %T') kopija: backups/erp-$stamp.dump ($(du -h "backups/erp-$stamp.dump" | cut -f1))"
