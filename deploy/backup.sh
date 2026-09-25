#!/usr/bin/env bash
# Sigurnosna kopija: baza (svaki dan, čuva se 30 dana) i datoteke izvan baze — MDM datoteke (/data/mdm)
# i storage/ programa (/app/storage: automatske kopije iz programa) — čuvaju se 7 dana.
# Prilozi dokumenata (računi, ugovori, servis…) su u bazi i ulaze u kopiju baze.
# Cron (svaku noć u 2:30):  30 2 * * * /opt/erp/deploy/backup.sh >> /opt/erp/deploy/backups/backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p backups
stamp=$(date +%F-%H%M)
docker compose exec -T db pg_dump -U erp -Fc erp > "backups/erp-$stamp.dump.part"
mv "backups/erp-$stamp.dump.part" "backups/erp-$stamp.dump"
# datoteke: MDM i storage/ u jednoj arhivi (mdm/… i storage/…)
if docker compose run --rm --no-deps -T -v "$PWD/backups:/b" --entrypoint sh app \
  -c "mkdir -p /data/mdm /app/storage && tar czf /b/files-$stamp.tgz.part -C /data mdm -C /app storage && mv /b/files-$stamp.tgz.part /b/files-$stamp.tgz" >/dev/null 2>&1; then
  echo "$(date '+%F %T') datoteke: backups/files-$stamp.tgz ($(du -h "backups/files-$stamp.tgz" | cut -f1))"
else
  rm -f "backups/files-$stamp.tgz.part"
  echo "$(date '+%F %T') UPOZORENJE: kopija datoteka (MDM, storage) nije uspjela" >&2
fi
find backups -name 'erp-*.dump' -mtime +30 -delete
find backups \( -name 'files-*.tgz' -o -name 'mdm-*.tgz' \) -mtime +7 -delete
echo "$(date '+%F %T') kopija: backups/erp-$stamp.dump ($(du -h "backups/erp-$stamp.dump" | cut -f1))"
