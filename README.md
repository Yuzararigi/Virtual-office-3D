# Kantor Virtual 3D

Kantor virtual multi-user ala Gather.town: ruangan 3D bersama di browser, avatar,
chat teks, **audio** (WebRTC), papan task kanban, dan tata letak furnitur yang bisa
diedit admin. Hanya orang yang memegang **link undangan** yang bisa masuk.

## Menjalankan (Mac): dari dashboard Pusat Kendali AI

Buka **http://127.0.0.1:8080/lokal** → baris `kantor-virtual-3d`:

- **Jalankan / Hentikan / Restart / Log** — mengendalikan kontainer Docker.
- **Wi-Fi: Mati / Nyala** — Mati = hanya laptop ini yang bisa membuka kantor;
  Nyala = perangkat lain di Wi-Fi yang sama juga bisa (lewat link undangan).
  Dashboard menulis `LAN_BIND` di `.env` lalu membuat ulang kontainer.
- Tautan **:8095** di kolom *Buka* → `https://127.0.0.1:8095` (atau `http://` bila
  belum ada sertifikat).

Setelah mengubah `server.js` / `public/`, cukup klik **Restart** (kode dipasang
langsung dari folder). Build ulang hanya bila `package.json` berubah:
`cd ~/workspace/kantor-virtual-3d && caffeinate -is docker compose up -d --build`

## Mengundang orang

1. Dashboard → Proyek lokal → kantor-virtual-3d → **Log**. Buka link
   `Kelola undangan (admin): …/admin.html#kode=…` (kode admin juga ada di
   `data/undangan.json`, kolom `admin`).
2. Isi **Alamat kantor untuk tamu** dengan alamat yang bisa dijangkau tamu:
   - satu Wi-Fi: `https://IP-Mac:8095` (cek IP: `caffeinate -i ipconfig getifaddr en0`)
   - dari luar / Wi-Fi kantor yang memblokir antarperangkat: alamat Tailscale `https://100.x.x.x:8095`
3. Ketik nama tamu, pilih masa berlaku → **Buat undangan** → link tersalin, kirim ke tamu.
4. Tamu membuka link → nama terisi & terkunci → **Masuk**.
5. **Cabut** kapan saja — bila tamu sedang di dalam, ia langsung dikeluarkan.

Anda sendiri masuk lewat **Masuk kantor sebagai admin** di halaman undangan.
Mode edit furnitur & panel admin di dalam kantor: tombol admin, atau ketik
`/admin <kode admin>` di chat. **Jangan bagikan kode admin.**

## Audio dari perangkat lain

Browser hanya mengizinkan mikrofon di HTTPS (atau localhost):

- `caffeinate -i ./buat-sertifikat.sh` — membuat sertifikat self-signed di `data/`
  (ulangi bila IP Wi-Fi berubah), lalu Restart. Tamu perlu menerima peringatan
  sertifikat sekali di browsernya.
- Opsional, bila audio antar-perangkat tidak tersambung: server TURN (coturn) di Mac,
  `caffeinate -i ./jalankan-turn.sh` (butuh `TURN_SECRET` di `.env`). Kredensial TURN hanya
  diberikan ke tamu yang sah dan berlaku 6 jam; relay ke laptop ini & jaringan internal Docker diblokir.

## Keamanan — ringkas

- Masuk wajib link undangan pribadi atau kode admin acak (tidak ada kata sandi bawaan).
  `ADMIN_PASSWORD` di `.env` opsional sebagai kata sandi admin tambahan.
- Tebakan kode admin dibatasi 10× per menit; pesan > 64 KB ditolak; papan maks 300 kartu,
  furnitur maks 600 dan isinya divalidasi.
- `.env` (TURN_SECRET) dan `data/` (kunci HTTPS, undangan) jangan pernah di-commit (`.gitignore`).
- Wi-Fi kantor yang memblokir koneksi antarperangkat tidak bisa ditembus dari Mac —
  pakai Tailscale atau hotspot HP.

## Tanpa Docker

- Mac: klik dua kali `Jalankan.command`. Windows: `Jalankan.bat`.
- Manual: `npm install` lalu `caffeinate -is node server.js` → http(s)://localhost:8095

## Struktur

```
server.js            HTTP(S) + WebSocket, undangan, admin, furnitur, sinyal WebRTC
public/index.html    kerangka UI
public/client.js     dunia 3D Three.js, audio, editor furnitur
public/admin.html    halaman kelola undangan
public/style.css     gaya UI
test/smoke.js        uji otomatis end-to-end (npm test)
compose.yaml         dipakai dashboard (port 8095, LAN_BIND)
data/                tasks.json, furniture.json, undangan.json, cert.pem/key.pem
buat-sertifikat.sh   sertifikat HTTPS lokal
jalankan-turn.sh     coturn (relay audio) di macOS
```
