#!/bin/bash
# Membuat sertifikat HTTPS self-signed di data/ agar mikrofon bisa dipakai dari perangkat lain.
# Jalankan ulang bila IP Wi-Fi laptop berubah. Restart server setelahnya.
cd "$(dirname "$0")" || exit 1
mkdir -p data
IP="$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
HOST="$(scutil --get LocalHostName 2>/dev/null)"
SAN="DNS:localhost,IP:127.0.0.1${HOST:+,DNS:$HOST.local}${IP:+,IP:$IP}"
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout data/key.pem -out data/cert.pem \
  -subj "/CN=Kantor Virtual 3D" -addext "subjectAltName=$SAN" || exit 1
chmod 600 data/key.pem
echo "Sertifikat dibuat untuk: $SAN"
# coturn mengikat IP saat start: restart agar memakai IP baru.
if command -v brew >/dev/null 2>&1 && brew services list 2>/dev/null | grep -q '^coturn.*started'; then
  brew services restart coturn >/dev/null
fi
echo "Restart server (docker compose restart), lalu buka https://${IP:-localhost}:8095"
