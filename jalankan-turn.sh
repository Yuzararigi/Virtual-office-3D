#!/bin/bash
# Server TURN (coturn) untuk audio, berjalan langsung di macOS lewat Homebrew.
# Di luar Docker agar relay UDP langsung memakai IP Wi-Fi laptop (tanpa NAT Docker).
# Jalankan ulang bila IP Wi-Fi berubah (coturn mengikat IP saat start).
# Menulis konfigurasi dari .env (TURN_SECRET) lalu (re)start layanan brew.
cd "$(dirname "$0")" || exit 1
command -v turnserver >/dev/null 2>&1 || brew install coturn || exit 1
SECRET="$(grep '^TURN_SECRET=' .env | cut -d= -f2)"
[ -n "$SECRET" ] || { echo "TURN_SECRET belum ada di .env"; exit 1; }
CONF="$(brew --prefix)/etc/turnserver.conf"
cat > "$CONF" <<CONF
listening-port=3478
min-port=49160
max-port=49200
realm=kantor
fingerprint
use-auth-secret
static-auth-secret=$SECRET
no-tls
no-dtls
no-cli
log-file=stdout
# Pengaman relay: jangan teruskan ke laptop ini sendiri, jaringan internal Colima/Docker,
# link-local, dan multicast. (Perangkat lain di Wi-Fi tetap boleh, itu fungsi TURN.)
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.5.0-192.168.5.255
denied-peer-ip=224.0.0.0-255.255.255.255
denied-peer-ip=::1
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
CONF
chmod 600 "$CONF"
brew services restart coturn
echo "coturn dimulai ulang dengan konfigurasi baru."
