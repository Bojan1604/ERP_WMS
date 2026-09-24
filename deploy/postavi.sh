#!/usr/bin/env bash
# Prvo postavljanje na poslužitelju: upiše deploy/.env (domena, nasumične lozinke)
# i pripremi Windows agenta za MDM. Pokreće se jednom:  cd deploy && bash postavi.sh
set -euo pipefail
cd "$(dirname "$0")"

if [ -f .env ]; then
  echo "deploy/.env već postoji — ne diram ga (lozinke bi se promijenile i program ne bi mogao do baze)."
else
  read -rp "Domena programa (npr. erp.mojafirma.hr): " DOMAIN
  DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN%%/*}"
  [ -n "$DOMAIN" ] || { echo "Domena je obavezna."; exit 1; }
  read -rp "E-adresa za obavijesti o HTTPS certifikatu: " ACME_EMAIL
  umask 077
  cat > .env <<ENV
# Produkcijske postavke — NE dijelite ovu datoteku (lozinke i ključ za šifriranje).
DOMAIN=$DOMAIN
ACME_EMAIL=$ACME_EMAIL
POSTGRES_PASSWORD=$(openssl rand -hex 24)
# Ključ za prijave i šifriranje certifikata / API ključeva. Ako se promijeni, certifikat i ključ posrednika upisuju se ponovno.
AUTH_SECRET=$(openssl rand -base64 48 | tr -d '\n')
SESSION_TTL_HOURS=12

# Sudski registar za gumb „Dohvati" (besplatno: sudreg-data.gov.hr → Registracija). Bez njih se koristi VIES.
SUDREG_CLIENT_ID=
SUDREG_CLIENT_SECRET=

# eRačun: oznaka programa koju šaljete posredniku (ostavite ako posrednik ne traži drukčije)
EINVOICE_SOFTWARE_ID=erp-wms

# MDM: potpis Android agenta za QR upis (ako nije u agents/android/signature-checksum.txt)
MDM_ANDROID_SIGNATURE_CHECKSUM=
ENV
  echo "Upisano: deploy/.env"
fi

# Windows agent za MDM (Android APK se dodaje iz GitHub Actions u deploy/agents/android/)
mkdir -p agents/windows agents/android backups
python3 - <<'PY'
import zipfile, os
src = '../agents/windows'
files = ['WmsAgent.ps1', 'WmsAgent.psm1', 'UserAgent.ps1', 'install.ps1', 'uninstall.ps1']
with zipfile.ZipFile('agents/windows/wms-agent.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    for f in files:
        z.write(os.path.join(src, f), f)
open('agents/windows/install.ps1', 'wb').write(open(os.path.join(src, 'install.ps1'), 'rb').read())
print('Windows agent spreman: deploy/agents/windows/')
PY

echo
echo "Sljedeće:  docker compose up -d --build"
