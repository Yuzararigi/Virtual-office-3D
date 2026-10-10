#!/bin/bash
# Kantor Virtual 3D — peluncur macOS tanpa Docker (klik dua kali di Finder).
# Lebih disarankan: jalankan dari dashboard Pusat Kendali AI (tab Proyek lokal).
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js tidak ditemukan. Install dulu: brew install node"
  read -r -p "Tekan Enter untuk menutup..."; exit 1
fi
if [ ! -d node_modules ]; then
  echo "Menginstall dependensi, mohon tunggu..."
  npm install || { echo "npm install gagal. Periksa koneksi internet."; read -r -p "Tekan Enter..."; exit 1; }
fi
mkdir -p data
export PORT="${PORT:-8095}" TASKS_FILE="$PWD/data/tasks.json"
echo
PROTO=http; [ -f data/cert.pem ] && [ -f data/key.pem ] && PROTO=https
echo "Kantor Virtual 3D berjalan di $PROTO://localhost:$PORT"
echo "Tekan Ctrl+C untuk berhenti."
echo
( sleep 1; open "$PROTO://localhost:$PORT" ) &
# caffeinate: Mac tidak tidur selama server berjalan
exec caffeinate -is node server.js
