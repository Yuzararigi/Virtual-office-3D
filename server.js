// server.js — Kantor Virtual 3D (self-hosted, multi-user, chat + audio WebRTC).
// Hanya pemegang link undangan / kode admin yang bisa masuk (lihat README: Mengundang orang).
// Satu ruangan bersama: HTTP menyajikan public/, WebSocket di port yang sama.
// Protokol JSON (lihat README.md untuk ringkasannya).
import http from 'node:http';
import https from 'node:https';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = path.join(DIR, 'public');
// Bisa dioverride lewat env TASKS_FILE (dipakai test agar tidak mengotori data asli).
const TASKS_PATH = process.env.TASKS_FILE || path.join(DIR, 'tasks.json');
const FURNITURE_PATH = process.env.FURNITURE_FILE || path.join(DIR, 'furniture.json');
// Kata sandi admin tambahan (opsional). Kode admin utama dibuat acak di undangan.json.
// TIDAK ada kata sandi bawaan: tanpa ADMIN_PASSWORD hanya kode admin acak yang berlaku.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const UNDANGAN_PATH = process.env.UNDANGAN_FILE || path.join(path.dirname(TASKS_PATH), 'undangan.json');
const WAJIB_UNDANGAN = process.env.WAJIB_UNDANGAN !== '0'; // WAJIB_UNDANGAN=0 = siapa pun boleh masuk
// 8095: 8080 dipakai dashboard Pusat Kendali AI, 8090 dipakai book-studio.
const PORT = Number(process.env.PORT ?? 8095);
const MAX_PAYLOAD = 64 * 1024;  // pesan WebSocket terbesar (cukup untuk sinyal WebRTC)
const MAX_TASKS = 300;
const MAX_FURNITURE = 600;
const MAX_UNDANGAN = 200;
const HARI_MS = 24 * 3600 * 1000;
const TURN_TTL_S = 6 * 3600;    // umur kredensial TURN (detik)
// HTTPS opsional: jika data/cert.pem + data/key.pem ada (buat dengan buat-sertifikat.sh),
// server berjalan di HTTPS. Wajib agar mikrofon bisa dipakai dari perangkat lain
// (browser hanya mengizinkan getUserMedia di HTTPS atau localhost).
const TLS_DIR = process.env.TLS_DIR || path.join(DIR, 'data');
const TLS_CERT = path.join(TLS_DIR, 'cert.pem');
const TLS_KEY = path.join(TLS_DIR, 'key.pem');
const USE_TLS = process.env.HTTPS !== '0' && existsSync(TLS_CERT) && existsSync(TLS_KEY);
// TURN (coturn di compose.yaml) untuk audio bila koneksi langsung antar-laptop gagal.
// Kredensial sementara dibuat dari TURN_SECRET (mode use-auth-secret coturn).
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_PORT = Number(process.env.TURN_PORT ?? 3478);

// Batas area gerak pemain (sedikit di dalam dinding). Lantai 34 x 22 m.
const ROOM = { x: 17, z: 11 };
// Palet warna avatar — tiap pengguna dapat satu warna berbeda (berputar jika penuh).
const PALETTE = [
  '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c',
  '#e67e22', '#fd79a8', '#00cec9', '#6c5ce7', '#fdcb6e', '#00b894',
];
const TASK_COLS = ['antri', 'dikerjakan', 'selesai'];

// ---------- state ----------
const users = new Map(); // ws -> { id, name, color, x, z, ry, isAdmin }
let tasks = [];          // [{ id, title, col }]
let furniture = [];      // [{ id, type, x, y, z, ry, opts }]
let taskSeq = 0;
let roomLocked = false;  // Jika true, user baru tidak bisa masuk
let voiceDisabled = false; // Jika true, voice chat dinonaktifkan untuk semua
// { admin: 'kode-admin', daftar: [{ kode, nama, dibuat, berlaku_sampai|null, dicabut, terakhir_masuk|null }] }
let undangan = { admin: '', daftar: [] };

function nextTaskId() {
  taskSeq += 1;
  return `t${taskSeq}`;
}

// ---------- util ----------
function sanitizeName(raw) {
  let name = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!name) name = 'Tamu';
  return name.slice(0, 20);
}

// "Budi" -> "Budi (2)" jika nama sudah dipakai.
function uniqueName(wanted) {
  const taken = new Set([...users.values()].map((u) => u.name));
  if (!taken.has(wanted)) return wanted;
  let n = 2;
  while (taken.has(`${wanted} (${n})`)) n += 1;
  return `${wanted} (${n})`;
}

// Warna yang paling sedikit dipakai (tidak kembar setelah ada yang keluar-masuk).
function pickColor() {
  const used = new Map(PALETTE.map((c) => [c, 0]));
  for (const u of users.values()) used.set(u.color, (used.get(u.color) ?? 0) + 1);
  let best = PALETTE[0];
  for (const c of PALETTE) if (used.get(c) < used.get(best)) best = c;
  return best;
}

function spawnPoint() {
  const i = users.size;
  // Sebar di koridor tengah yang lapang dan bebas dari segala collider (x: -8.2..-7.8, z: 4.5..8.0)
  const zOffset = (i % 6) * 0.65;
  const xOffset = ((i % 2) - 0.5) * 0.4;
  return { x: -8.0 + xOffset, y: 0, z: 4.5 + zOffset, ry: Math.PI / 2 };
}

function clampMove(x, z) {
  const cx = Math.max(-ROOM.x, Math.min(ROOM.x, Number.isFinite(x) ? x : 0));
  const cz = Math.max(-ROOM.z, Math.min(ROOM.z, Number.isFinite(z) ? z : 0));
  return { x: cx, z: cz };
}

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    color: u.color,
    x: u.x,
    y: u.y,
    z: u.z,
    ry: u.ry,
    sitting: u.sitting,
    micActive: Boolean(u.micActive),
    speaking: Boolean(u.speaking),
  };
}

// Daftar ICE server untuk klien; host TURN = host yang dipakai klien membuka halaman.
function iceServersFor(host) {
  const list = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (TURN_SECRET && host) {
    const username = `${Math.floor(Date.now() / 1000) + TURN_TTL_S}:kantor`;
    const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
    list.push({
      urls: [`stun:${host}:${TURN_PORT}`, `turn:${host}:${TURN_PORT}?transport=udp`, `turn:${host}:${TURN_PORT}?transport=tcp`],
      username,
      credential,
    });
  }
  return list;
}

function broadcast(obj, exceptWs = null) {
  const line = JSON.stringify(obj);
  for (const [ws] of users) {
    if (ws === exceptWs) continue;
    if (ws.readyState === 1) ws.send(line);
  }
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// ---------- persistensi furnitur ----------
function defaultFurniture() {
  return [
    // --- Multipurpose Room (musholla): x -17..-9, z -11..-4
    { id: 'f_musholla_1', type: 'prayer_mat', x: -13, y: 0, z: -9.5, ry: 0 },
    { id: 'f_musholla_2', type: 'prayer_mat', x: -15.2, y: 0, z: -7, ry: 0 },
    { id: 'f_musholla_3', type: 'prayer_mat', x: -13, y: 0, z: -7, ry: 0 },
    { id: 'f_musholla_4', type: 'prayer_mat', x: -10.8, y: 0, z: -7, ry: 0 },
    { id: 'f_musholla_5', type: 'mihrab', x: -13, y: 0, z: -10.82, ry: 0 },

    // --- Meeting Room: x -7..9, z -11..-4
    { id: 'f_meet_table', type: 'meeting_table', x: 1, y: 0, z: -7.5, ry: 0 },
    { id: 'f_meet_c1', type: 'chair_blue', x: -2.5, y: 0, z: -9.35, ry: 0 },
    { id: 'f_meet_c2', type: 'chair_black', x: -2.5, y: 0, z: -5.65, ry: Math.PI },
    { id: 'f_meet_c3', type: 'chair_black', x: -1.1, y: 0, z: -9.35, ry: 0 },
    { id: 'f_meet_c4', type: 'chair_blue', x: -1.1, y: 0, z: -5.65, ry: Math.PI },
    { id: 'f_meet_c5', type: 'chair_blue', x: 0.3, y: 0, z: -9.35, ry: 0 },
    { id: 'f_meet_c6', type: 'chair_black', x: 0.3, y: 0, z: -5.65, ry: Math.PI },
    { id: 'f_meet_c7', type: 'chair_black', x: 1.7, y: 0, z: -9.35, ry: 0 },
    { id: 'f_meet_c8', type: 'chair_blue', x: 1.7, y: 0, z: -5.65, ry: Math.PI },
    { id: 'f_meet_c9', type: 'chair_blue', x: 3.1, y: 0, z: -9.35, ry: 0 },
    { id: 'f_meet_c10', type: 'chair_black', x: 3.1, y: 0, z: -5.65, ry: Math.PI },
    { id: 'f_meet_c11', type: 'chair_black', x: 4.5, y: 0, z: -9.35, ry: 0 },
    { id: 'f_meet_c12', type: 'chair_blue', x: 4.5, y: 0, z: -5.65, ry: Math.PI },
    { id: 'f_meet_c13', type: 'chair_blue', x: 5.85, y: 0, z: -8.2, ry: -Math.PI / 2 },
    { id: 'f_meet_c14', type: 'chair_black', x: 5.85, y: 0, z: -6.8, ry: -Math.PI / 2 },
    { id: 'f_meet_tv', type: 'tv', x: -6.76, y: 0, z: -7.5, ry: Math.PI / 2 },
    { id: 'f_meet_ac1', type: 'ac', x: 2, y: 0, z: -10.78, ry: 0 },
    { id: 'f_meet_ac2', type: 'ac', x: 6, y: 0, z: -10.78, ry: 0 },

    // --- Pantry: x 11..17, z -11..-7
    { id: 'f_pantry_counter', type: 'kitchen_counter', x: 14.1, y: 0, z: -10.6, ry: 0 },
    { id: 'f_pantry_fridge', type: 'fridge', x: 11.65, y: 0, z: -10.42, ry: 0 },
    { id: 'f_pantry_dispenser', type: 'dispenser', x: 16.45, y: 0, z: -10.45, ry: 0 },
    { id: 'f_pantry_table', type: 'desk', x: 14, y: 0, z: -8.2, ry: 0, opts: { w: 1.8, d: 1.0 } },
    { id: 'f_pantry_c1', type: 'chair_blue', x: 13.5, y: 0, z: -9.05, ry: 0 },
    { id: 'f_pantry_c2', type: 'chair_black', x: 14.5, y: 0, z: -9.05, ry: 0 },
    { id: 'f_pantry_c3', type: 'chair_black', x: 13.5, y: 0, z: -7.35, ry: Math.PI },
    { id: 'f_pantry_c4', type: 'chair_blue', x: 14.5, y: 0, z: -7.35, ry: Math.PI },

    // --- Relax Room: x 11..17, z -7..-2
    { id: 'f_relax_sofa', type: 'sofa', x: 15.9, y: 0, z: -4.5, ry: -Math.PI / 2 },
    { id: 'f_relax_coffee', type: 'coffee_table', x: 14.4, y: 0, z: -4.5, ry: 0 },
    { id: 'f_relax_bb1', type: 'beanbag_red', x: 13.2, y: 0, z: -3.2, ry: 0 },
    { id: 'f_relax_bb2', type: 'beanbag_blue', x: 13.2, y: 0, z: -5.8, ry: 0 },
    { id: 'f_relax_books', type: 'bookshelf', x: 12.5, y: 0, z: -6.6, ry: 0 },
    { id: 'f_relax_rug', type: 'rug', x: 14.5, y: 0, z: -4.5, ry: 0 },

    // --- Head Room 1: x -17..-9, z -4..1
    { id: 'f_head1_ws', type: 'workstation', x: -13, y: 0, z: -1.8, ry: 0, opts: { side: 'S', w: 2.2, d: 1.1, color: 0x2a4d8f } },

    // --- Head Room 2: x -17..-9, z 1..11
    { id: 'f_head2_ws', type: 'workstation', x: -13, y: 0, z: 3.5, ry: 0, opts: { side: 'S', w: 2.2, d: 1.1, color: 0x23262b } },
    { id: 'f_head2_cab', type: 'cabinet', x: -13, y: 0, z: 10.35, ry: 0, opts: { w: 2.0, h: 1.3, d: 0.5 } },

    // --- Office: x -7..9, z -4..11
    // Klaster kiri
    { id: 'f_off_desk_l1', type: 'desk', x: -4.15, y: 0, z: -0.5, ry: 0, opts: { w: 1.3, d: 3.9 } },
    { id: 'f_off_desk_l2', type: 'desk', x: -2.85, y: 0, z: -0.5, ry: 0, opts: { w: 1.3, d: 3.9 } },
    { id: 'f_off_lap_l1', type: 'laptop', x: -4.15, y: 0, z: -1.8, ry: -Math.PI / 2 },
    { id: 'f_off_lap_l2', type: 'laptop', x: -2.85, y: 0, z: -1.8, ry: Math.PI / 2 },
    { id: 'f_off_c_l1', type: 'chair_blue', x: -5.2, y: 0, z: -1.8, ry: Math.PI / 2 },
    { id: 'f_off_c_l2', type: 'chair_black', x: -1.8, y: 0, z: -1.8, ry: -Math.PI / 2 },
    { id: 'f_off_lap_l3', type: 'laptop', x: -4.15, y: 0, z: -0.5, ry: -Math.PI / 2 },
    { id: 'f_off_lap_l4', type: 'laptop', x: -2.85, y: 0, z: -0.5, ry: Math.PI / 2 },
    { id: 'f_off_c_l3', type: 'chair_blue', x: -5.2, y: 0, z: -0.5, ry: Math.PI / 2 },
    { id: 'f_off_c_l4', type: 'chair_black', x: -1.8, y: 0, z: -0.5, ry: -Math.PI / 2 },
    { id: 'f_off_lap_l5', type: 'laptop', x: -4.15, y: 0, z: 0.8, ry: -Math.PI / 2 },
    { id: 'f_off_lap_l6', type: 'laptop', x: -2.85, y: 0, z: 0.8, ry: Math.PI / 2 },
    { id: 'f_off_c_l5', type: 'chair_blue', x: -5.2, y: 0, z: 0.8, ry: Math.PI / 2 },
    { id: 'f_off_c_l6', type: 'chair_black', x: -1.8, y: 0, z: 0.8, ry: -Math.PI / 2 },

    // Klaster kanan
    { id: 'f_off_desk_r1', type: 'desk', x: 3.85, y: 0, z: -0.5, ry: 0, opts: { w: 1.3, d: 3.9 } },
    { id: 'f_off_desk_r2', type: 'desk', x: 5.15, y: 0, z: -0.5, ry: 0, opts: { w: 1.3, d: 3.9 } },
    { id: 'f_off_lap_r1', type: 'laptop', x: 3.85, y: 0, z: -1.8, ry: -Math.PI / 2 },
    { id: 'f_off_lap_r2', type: 'laptop', x: 5.15, y: 0, z: -1.8, ry: Math.PI / 2 },
    { id: 'f_off_c_r1', type: 'chair_black', x: 2.8, y: 0, z: -1.8, ry: Math.PI / 2 },
    { id: 'f_off_c_r2', type: 'chair_blue', x: 6.2, y: 0, z: -1.8, ry: -Math.PI / 2 },
    { id: 'f_off_lap_r3', type: 'laptop', x: 3.85, y: 0, z: -0.5, ry: -Math.PI / 2 },
    { id: 'f_off_lap_r4', type: 'laptop', x: 5.15, y: 0, z: -0.5, ry: Math.PI / 2 },
    { id: 'f_off_c_r3', type: 'chair_black', x: 2.8, y: 0, z: -0.5, ry: Math.PI / 2 },
    { id: 'f_off_c_r4', type: 'chair_blue', x: 6.2, y: 0, z: -0.5, ry: -Math.PI / 2 },
    { id: 'f_off_lap_r5', type: 'laptop', x: 3.85, y: 0, z: 0.8, ry: -Math.PI / 2 },
    { id: 'f_off_lap_r6', type: 'laptop', x: 5.15, y: 0, z: 0.8, ry: Math.PI / 2 },
    { id: 'f_off_c_r5', type: 'chair_black', x: 2.8, y: 0, z: 0.8, ry: Math.PI / 2 },
    { id: 'f_off_c_r6', type: 'chair_blue', x: 6.2, y: 0, z: 0.8, ry: -Math.PI / 2 },

    // Office TV, Meja tunggal, Peralatan
    { id: 'f_off_tv1', type: 'tv', x: -5.5, y: 0, z: -3.76, ry: 0 },
    { id: 'f_off_tv2', type: 'tv', x: 5.5, y: 0, z: -3.76, ry: 0 },
    { id: 'f_off_ws1', type: 'workstation', x: -3.5, y: 0, z: 7.5, ry: 0, opts: { side: 'S', w: 2.4, d: 1.1, color: 0x2a4d8f } },
    { id: 'f_off_ws2', type: 'workstation', x: 3.5, y: 0, z: 7.5, ry: 0, opts: { side: 'S', w: 2.4, d: 1.1, color: 0x23262b } },
    { id: 'f_off_printer', type: 'printer', x: 0, y: 0, z: 7.5, ry: 0 },
    { id: 'f_off_dispenser', type: 'dispenser', x: 1.7, y: 0, z: 7.5, ry: 0 },
    { id: 'f_off_ac1', type: 'ac', x: -6, y: 0, z: 10.78, ry: Math.PI },
    { id: 'f_off_ac2', type: 'ac', x: 6, y: 0, z: 10.78, ry: Math.PI },
    { id: 'f_off_clock', type: 'clock', x: -6.8, y: 0, z: 2, ry: Math.PI / 2 },
    { id: 'f_off_board', type: 'board', x: 0, y: 0, z: 10.66, ry: Math.PI },

    // --- Boss Room: x 11..17, z -2..4
    { id: 'f_boss_ws', type: 'workstation', x: 14, y: 0, z: 1, ry: 0, opts: { side: 'S', w: 2.6, d: 1.3, color: 0x2a4d8f } },
    { id: 'f_boss_cab', type: 'cabinet', x: 16.0, y: 0, z: 3.3, ry: 0, opts: { w: 1.5, h: 1.1, d: 0.5 } },

    // --- Toilet: x 11..17, z 4..11
    { id: 'f_toilet_b1', type: 'toilet_bowl', x: 16.3, y: 0, z: 5.8, ry: -Math.PI / 2 },
    { id: 'f_toilet_b2', type: 'toilet_bowl', x: 16.3, y: 0, z: 9.2, ry: -Math.PI / 2 },
    { id: 'f_toilet_sink1', type: 'sink', x: 12.5, y: 0, z: 4.4, ry: 0 },
    { id: 'f_toilet_sink2', type: 'sink', x: 13.6, y: 0, z: 4.4, ry: 0 },

    // --- Corridors
    { id: 'f_corr_plant1', type: 'plant', x: -8.6, y: 0, z: 10.3, ry: 0 },
    { id: 'f_corr_plant2', type: 'plant', x: 10.6, y: 0, z: 10.3, ry: 0 },
    { id: 'f_corr_plant3', type: 'plant', x: 10.6, y: 0, z: -10.3, ry: 0 },
    { id: 'f_corr_plant4', type: 'plant', x: -8.6, y: 0, z: -10.3, ry: 0 },
  ];
}

async function loadFurniture() {
  try {
    const raw = await fs.readFile(FURNITURE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      furniture = parsed.map(bersihkanFurnitur).filter(Boolean).slice(0, MAX_FURNITURE);
      return;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Gagal memuat furniture.json:', err.message);
  }
  furniture = defaultFurniture();
  void saveFurniture();
}

// Tulis ke file sementara lalu rename: file tidak pernah setengah-tertulis.
async function tulisAtomik(file, data, mode = 0o644) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, data, { encoding: 'utf8', mode });
  await fs.rename(tmp, file);
}

// Simpanan berurutan per file agar dua perubahan cepat tidak saling menimpa.
const rantai = new Map();
function antriSimpan(nama, fn) {
  const p = (rantai.get(nama) || Promise.resolve()).then(fn).catch((err) => console.error(`Gagal menyimpan ${nama}:`, err.message));
  rantai.set(nama, p);
  return p;
}

function saveFurniture() {
  return antriSimpan('furniture', () => tulisAtomik(FURNITURE_PATH, JSON.stringify(furniture, null, 2)));
}

// ---------- undangan + kode admin ----------
function kodeBaru() {
  return crypto.randomBytes(12).toString('base64url'); // 16 karakter, mustahil ditebak
}

function kodeSama(a, b) {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function checkAdminCode(code) {
  const c = String(code ?? '').trim();
  if (!c) return false;
  return kodeSama(c, undangan.admin) || (ADMIN_PASSWORD !== '' && kodeSama(c, ADMIN_PASSWORD));
}

// Rem tebakan kode admin: maks 10 percobaan salah per menit (gabungan semua sumber).
const gagalAdmin = { n: 0, sejak: 0 };
function remAdmin() {
  const now = Date.now();
  if (now - gagalAdmin.sejak > 60_000) { gagalAdmin.n = 0; gagalAdmin.sejak = now; }
  return gagalAdmin.n >= 10;
}
function cekAdminDenganRem(code) {
  if (remAdmin()) return { ok: false, rem: true };
  const ok = checkAdminCode(code);
  if (!ok && String(code ?? '').trim()) gagalAdmin.n += 1;
  return { ok, rem: false };
}

async function loadUndangan() {
  try {
    const parsed = JSON.parse(await fs.readFile(UNDANGAN_PATH, 'utf8'));
    undangan.admin = typeof parsed.admin === 'string' ? parsed.admin : '';
    undangan.daftar = Array.isArray(parsed.daftar)
      ? parsed.daftar.filter((u) => u && typeof u.kode === 'string' && typeof u.nama === 'string')
      : [];
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Gagal memuat undangan.json:', err.message);
  }
  if (process.env.KODE_ADMIN) undangan.admin = process.env.KODE_ADMIN;
  // Kode lama yang lemah (mis. "admin123") diganti dengan kode acak.
  if (!undangan.admin || undangan.admin.length < 12) {
    undangan.admin = kodeBaru();
    await saveUndangan();
  }
}

function saveUndangan() {
  return antriSimpan('undangan', () => tulisAtomik(UNDANGAN_PATH, JSON.stringify(undangan, null, 2), 0o600));
}

function statusUndangan(u) {
  if (u.dicabut) return 'dicabut';
  if (u.berlaku_sampai && u.berlaku_sampai <= Date.now()) return 'kedaluwarsa';
  return 'aktif';
}

// -> { admin: true } | { admin: false, u } | null (ditolak)
function cekKode(kode) {
  if (!kode) return null;
  if (checkAdminCode(kode)) return { admin: true };
  const u = undangan.daftar.find((x) => x.kode === kode);
  if (!u || statusUndangan(u) !== 'aktif') return null;
  return { admin: false, u };
}

// Keluarkan semua pemain yang masuk dengan kode ini (dipakai saat undangan dicabut).
function tendangKode(kode, alasan) {
  for (const [ws, u] of users) {
    if (u.kode === kode) {
      send(ws, { t: 'kicked', reason: alasan });
      ws.close(4001, 'undangan dicabut');
    }
  }
}

function daftarUntukAdmin() {
  const online = new Set([...users.values()].map((u) => u.kode).filter(Boolean));
  return undangan.daftar.map((u) => ({ ...u, status: statusUndangan(u), online: online.has(u.kode) }));
}

// ---------- validasi furnitur (data dari admin tetap dibatasi) ----------
const ANGKA = (v, min, max, def = 0) => (Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : def);
function bersihkanOpts(opts) {
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(opts).slice(0, 20)) {
    if (!/^[A-Za-z0-9_]{1,24}$/.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string' && v.length <= 40) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}
function bersihkanFurnitur(item) {
  if (!item || typeof item !== 'object' || typeof item.type !== 'string' || !/^[a-z0-9_]{1,40}$/.test(item.type)) return null;
  const id = typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(item.id)
    ? item.id : `f_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const f = {
    id, type: item.type,
    x: ANGKA(item.x, -ROOM.x - 1, ROOM.x + 1), y: ANGKA(item.y, 0, 5), z: ANGKA(item.z, -ROOM.z - 1, ROOM.z + 1),
    ry: ANGKA(item.ry, -100, 100),
  };
  const opts = bersihkanOpts(item.opts);
  if (opts) f.opts = opts;
  return f;
}

// ---------- persistensi tasks ----------
async function loadTasks() {
  try {
    const raw = await fs.readFile(TASKS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      tasks = parsed.filter(
        (t) => t && typeof t.id === 'string' && typeof t.title === 'string' && TASK_COLS.includes(t.col),
      );
      for (const t of tasks) {
        const m = /^t(\d+)$/.exec(t.id);
        if (m) taskSeq = Math.max(taskSeq, Number(m[1]));
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Gagal memuat tasks.json:', err.message);
    tasks = [];
  }
}

function saveTasks() {
  return antriSimpan('tasks', () => tulisAtomik(TASKS_PATH, JSON.stringify(tasks, null, 2)));
}

function broadcastTasks() {
  broadcast({ t: 'tasks', tasks });
  void saveTasks();
}

// ---------- handler pesan ----------
async function handleMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return; // abaikan payload bukan-JSON
  }
  if (!msg || typeof msg.t !== 'string') return;
  const me = users.get(ws);

  switch (msg.t) {
    case 'join': {
      if (me) return; // sudah join, abaikan join ganda
      // Admin: kode admin lewat adminCode/key atau link undangan admin. Tamu: link undangan pribadi.
      const adminCoba = String(msg.adminCode || msg.key || '').trim();
      const adm = adminCoba ? cekAdminDenganRem(adminCoba) : { ok: false };
      const akses = adm.ok ? { admin: true } : cekKode(typeof msg.undangan === 'string' ? msg.undangan : '');
      if (!akses && WAJIB_UNDANGAN) {
        send(ws, { t: 'kicked', reason: 'Kantor ini hanya untuk tamu undangan. Link undangan tidak sah, sudah dicabut, atau kedaluwarsa — minta link baru ke pengundang.' });
        ws.close(4001, 'tanpa undangan');
        return;
      }
      const isAdmin = Boolean(akses?.admin);
      // Jika ruangan dikunci dan bukan admin, tolak
      if (roomLocked && !isAdmin) {
        send(ws, { t: 'kicked', reason: 'Ruangan sedang dikunci oleh admin. Silakan coba lagi nanti.' });
        ws.close(4002, 'Room locked');
        return;
      }
      // Tamu undangan: nama dikunci sesuai undangan (tidak bisa menyamar).
      const name = uniqueName(sanitizeName(akses?.u ? akses.u.nama : msg.name));
      const color = pickColor();
      const spawn = spawnPoint();
      const user = { id: crypto.randomUUID(), name, color, isAdmin, ...spawn, kode: akses?.u?.kode ?? null };
      if (akses?.u) {
        akses.u.terakhir_masuk = Date.now();
        void saveUndangan();
      }
      users.set(ws, user);
      // Kirim snapshot awal ke pengguna baru.
      send(ws, {
        t: 'init',
        you: { id: user.id },
        users: [...users.values()].map(publicUser),
        tasks,
        furniture,
        isAdmin: Boolean(user.isAdmin),
        iceServers: iceServersFor(ws.host),
        roomLocked,
        voiceDisabled,
      });
      broadcast({ t: 'user_join', user: publicUser(user) }, ws);
      console.log(`+ ${name} bergabung (${users.size} online, admin: ${isAdmin})`);
      break;
    }

    case 'admin_auth': {
      if (!me) return;
      const hasil = cekAdminDenganRem(msg.key || msg.code || msg.password || msg.adminCode);
      if (hasil.ok) me.isAdmin = true;
      send(ws, {
        t: 'admin_auth_result',
        ok: hasil.ok,
        success: hasil.ok,
        isAdmin: hasil.ok,
        message: hasil.ok ? 'Berhasil masuk mode admin'
          : hasil.rem ? 'Terlalu banyak percobaan. Tunggu 1 menit.' : 'Kode/kata sandi admin salah',
      });
      break;
    }

    case 'furniture_add': {
      if (!me || !me.isAdmin) {
        send(ws, { t: 'error', message: 'Hanya admin yang dapat menambah furnitur' });
        return;
      }
      const item = bersihkanFurnitur(msg.item);
      if (!item) return;
      if (furniture.length >= MAX_FURNITURE) {
        send(ws, { t: 'error', message: `Maksimal ${MAX_FURNITURE} furnitur. Hapus sebagian dulu.` });
        return;
      }
      if (furniture.some((f) => f.id === item.id)) item.id = `f_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      furniture.push(item);
      broadcast({ t: 'furniture_add', item });
      void saveFurniture();
      break;
    }

    case 'furniture_update': {
      if (!me || !me.isAdmin) {
        send(ws, { t: 'error', message: 'Hanya admin yang dapat mengedit furnitur' });
        return;
      }
      const targetId = msg.item?.id || msg.id;
      const item = furniture.find((f) => f.id === targetId);
      if (!item) return;
      const updateData = msg.item || msg;
      if (Number.isFinite(updateData.x)) item.x = ANGKA(updateData.x, -ROOM.x - 1, ROOM.x + 1);
      if (Number.isFinite(updateData.y)) item.y = ANGKA(updateData.y, 0, 5);
      if (Number.isFinite(updateData.z)) item.z = ANGKA(updateData.z, -ROOM.z - 1, ROOM.z + 1);
      if (Number.isFinite(updateData.ry)) item.ry = ANGKA(updateData.ry, -100, 100);
      const optsBaru = bersihkanOpts(updateData.opts);
      if (optsBaru) item.opts = bersihkanOpts({ ...item.opts, ...optsBaru });
      broadcast({ t: 'furniture_update', item });
      void saveFurniture();
      break;
    }

    case 'furniture_delete': {
      if (!me || !me.isAdmin) {
        send(ws, { t: 'error', message: 'Hanya admin yang dapat menghapus furnitur' });
        return;
      }
      const before = furniture.length;
      furniture = furniture.filter((f) => f.id !== msg.id);
      if (furniture.length !== before) {
        broadcast({ t: 'furniture_delete', id: msg.id });
        void saveFurniture();
      }
      break;
    }

    case 'furniture_reset': {
      if (!me || !me.isAdmin) {
        send(ws, { t: 'error', message: 'Hanya admin yang dapat mereset furnitur' });
        return;
      }
      furniture = defaultFurniture();
      broadcast({ t: 'furniture_reset', furniture });
      broadcast({ t: 'furniture_list', furniture });
      void saveFurniture();
      break;
    }

    case 'kick': {
      if (!me || !me.isAdmin) {
        send(ws, { t: 'error', message: 'Hanya admin yang dapat mengeluarkan pengguna' });
        return;
      }
      if (!msg.id || msg.id === me.id) return;
      let targetWs = null, targetUser = null;
      for (const [tWs, tUser] of users) {
        if (tUser.id === msg.id) {
          targetWs = tWs;
          targetUser = tUser;
          break;
        }
      }
      if (!targetWs || !targetUser) return;
      
      const reason = typeof msg.reason === 'string' && msg.reason.trim()
        ? msg.reason.trim().slice(0, 100)
        : 'Dikeluarkan oleh admin';

      send(targetWs, { t: 'kicked', reason });
      broadcast({ t: 'chat', id: 'system', name: 'Sistem', text: `${targetUser.name} telah dikeluarkan oleh admin.`, ts: Date.now() });
      targetWs.close(4001, 'Kicked by admin');
      break;
    }

    case 'mute_all': {
      if (!me || !me.isAdmin) {
        send(ws, { t: 'error', message: 'Hanya admin yang dapat mematikan mikrofon semua pengguna' });
        return;
      }
      for (const [pWs, pUser] of users) {
        if (pWs === ws) continue;
        pUser.micActive = false;
        pUser.speaking = false;
      }
      broadcast({ t: 'mute_all', by: me.name });
      broadcast({ t: 'chat', id: 'system', name: 'Sistem', text: `${me.name} telah mematikan mikrofon semua peserta.`, ts: Date.now() });
      console.log(`🔇 ${me.name} mute all`);
      break;
    }

    case 'kick_all': {
      if (!me || !me.isAdmin) {
        send(ws, { t: 'error', message: 'Hanya admin yang dapat mengeluarkan semua pengguna' });
        return;
      }
      const kickReason = typeof msg.reason === 'string' && msg.reason.trim()
        ? msg.reason.trim().slice(0, 100)
        : 'Semua peserta dikeluarkan oleh admin';
      for (const [pWs, pUser] of users) {
        if (pWs === ws) continue;
        send(pWs, { t: 'kicked', reason: kickReason });
        pWs.close(4001, 'Kicked by admin (kick all)');
      }
      broadcast({ t: 'chat', id: 'system', name: 'Sistem', text: `${me.name} telah mengeluarkan semua peserta dari kantor.`, ts: Date.now() });
      console.log(`👢 ${me.name} kick all`);
      break;
    }

    case 'lock_room': {
      if (!me || !me.isAdmin) {
        send(ws, { t: 'error', message: 'Hanya admin yang dapat mengunci/membuka ruangan' });
        return;
      }
      roomLocked = Boolean(msg.locked);
      broadcast({ t: 'room_lock', locked: roomLocked, by: me.name });
      broadcast({ t: 'chat', id: 'system', name: 'Sistem', text: roomLocked ? `${me.name} telah mengunci ruangan. Tidak ada yang bisa masuk.` : `${me.name} telah membuka kunci ruangan.`, ts: Date.now() });
      console.log(`🔒 ${me.name} set room lock: ${roomLocked}`);
      break;
    }

    case 'disable_voice': {
      if (!me || !me.isAdmin) {
        send(ws, { t: 'error', message: 'Hanya admin yang dapat menonaktifkan voice' });
        return;
      }
      voiceDisabled = Boolean(msg.disabled);
      if (voiceDisabled) {
        for (const [pWs, pUser] of users) {
          pUser.micActive = false;
          pUser.speaking = false;
        }
      }
      broadcast({ t: 'voice_disabled', disabled: voiceDisabled, by: me.name });
      broadcast({ t: 'chat', id: 'system', name: 'Sistem', text: voiceDisabled ? `${me.name} telah menonaktifkan fitur voice/audio untuk semua peserta.` : `${me.name} telah mengaktifkan kembali fitur voice/audio.`, ts: Date.now() });
      console.log(`🚫 ${me.name} set voice disabled: ${voiceDisabled}`);
      break;
    }

    case 'move': {
      if (!me) return;
      const { x, z } = clampMove(msg.x, msg.z);
      const ry = Number.isFinite(msg.ry) ? msg.ry : me.ry;
      const y = Math.max(0, Math.min(1.4, Number.isFinite(msg.y) ? msg.y : me.y));
      me.x = x; me.y = y; me.z = z; me.ry = ry;
      me.sitting = msg.sitting === true;
      broadcast({ t: 'user_move', id: me.id, x, y, z, ry, sitting: me.sitting }, ws);
      break;
    }

    case 'rtc_signal': {
      if (!me || typeof msg.to !== 'string' || !msg.signal || typeof msg.signal !== 'object' || Array.isArray(msg.signal)) return;
      for (const [peerWs, peer] of users) {
        if (peer.id === msg.to && peerWs !== ws) {
          send(peerWs, { t: 'rtc_signal', from: me.id, signal: msg.signal });
          break;
        }
      }
      break;
    }

    case 'voice_status': {
      if (!me) return;
      // Jika voice dinonaktifkan secara global, tolak aktivasi
      if (voiceDisabled && msg.active) {
        send(ws, { t: 'voice_disabled', disabled: true, by: 'Admin' });
        return;
      }
      me.micActive = Boolean(msg.active);
      me.speaking = Boolean(msg.speaking);
      broadcast({ t: 'voice_status', id: me.id, active: me.micActive, speaking: me.speaking }, ws);
      break;
    }

    case 'chat': {
      if (!me) return;
      const text = String(msg.text ?? '').trim().slice(0, 500);
      if (!text) return;
      broadcast({ t: 'chat', id: me.id, name: me.name, text, ts: Date.now() });
      break;
    }

    case 'task_add': {
      if (!me) return;
      const title = String(msg.title ?? '').trim().slice(0, 120);
      if (!title) return;
      if (tasks.length >= MAX_TASKS) {
        send(ws, { t: 'error', message: `Papan penuh (maks ${MAX_TASKS} kartu). Hapus kartu yang selesai dulu.` });
        return;
      }
      const col = TASK_COLS.includes(msg.col) ? msg.col : 'antri';
      tasks.push({ id: nextTaskId(), title, col });
      broadcastTasks();
      break;
    }

    case 'task_move': {
      if (!me) return;
      const task = tasks.find((t) => t.id === msg.id);
      if (!task || !TASK_COLS.includes(msg.col)) return;
      task.col = msg.col;
      broadcastTasks();
      break;
    }

    case 'task_del': {
      if (!me) return;
      const before = tasks.length;
      tasks = tasks.filter((t) => t.id !== msg.id);
      if (tasks.length !== before) broadcastTasks();
      break;
    }

    default:
      break; // tipe tak dikenal: abaikan
  }
}

// ---------- HTTP: sajikan public/ ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function bacaBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 4096) throw new Error('body terlalu besar');
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { return {}; }
}

// API undangan. /api/cek publik (tamu mengecek link-nya); sisanya wajib header x-kode-admin.
async function handleApi(req, res, reqPath, url) {
  if (reqPath === '/api/cek' && req.method === 'GET') {
    if (!WAJIB_UNDANGAN) return json(res, 200, { wajib: false, sah: true });
    const a = cekKode(url.searchParams.get('undangan') || '');
    return json(res, 200, { wajib: true, sah: !!a, admin: !!a?.admin, nama: a?.u?.nama ?? null });
  }
  const auth = cekAdminDenganRem(req.headers['x-kode-admin']);
  if (auth.rem) return json(res, 429, { error: 'Terlalu banyak percobaan. Tunggu 1 menit.' });
  if (!auth.ok) return json(res, 401, { error: 'Kode admin salah.' });

  if (reqPath === '/api/undangan' && req.method === 'GET') {
    return json(res, 200, { daftar: daftarUntukAdmin(), wajib: WAJIB_UNDANGAN });
  }
  if (reqPath === '/api/undangan' && req.method === 'POST') {
    const body = await bacaBody(req);
    if (!String(body.nama ?? '').trim()) return json(res, 400, { error: 'Nama wajib diisi.' });
    const nama = sanitizeName(body.nama);
    const hari = Math.max(0, Math.min(365, Math.floor(Number(body.hari) || 0)));
    if (undangan.daftar.length >= MAX_UNDANGAN) return json(res, 400, { error: `Maksimal ${MAX_UNDANGAN} undangan. Hapus yang lama dulu.` });
    if (undangan.daftar.some((u) => u.nama.toLowerCase() === nama.toLowerCase() && statusUndangan(u) === 'aktif')) {
      return json(res, 400, { error: `Sudah ada undangan aktif atas nama "${nama}".` });
    }
    const u = { kode: kodeBaru(), nama, dibuat: Date.now(), berlaku_sampai: hari ? Date.now() + hari * HARI_MS : null, dicabut: false, terakhir_masuk: null };
    undangan.daftar.push(u);
    await saveUndangan();
    console.log(`Undangan dibuat untuk ${nama}`);
    return json(res, 200, { undangan: { ...u, status: 'aktif', online: false } });
  }
  if ((reqPath === '/api/undangan/cabut' || reqPath === '/api/undangan/hapus') && req.method === 'POST') {
    const { kode } = await bacaBody(req);
    const u = undangan.daftar.find((x) => x.kode === kode);
    if (!u) return json(res, 404, { error: 'Undangan tidak ditemukan.' });
    const cabut = reqPath.endsWith('/cabut');
    if (cabut) u.dicabut = true;
    else undangan.daftar = undangan.daftar.filter((x) => x !== u);
    tendangKode(u.kode, 'Undangan Anda sudah dicabut oleh pengundang.');
    await saveUndangan();
    console.log(`Undangan ${u.nama} ${cabut ? 'dicabut' : 'dihapus'}`);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'tidak ada' });
}

const handler = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let reqPath = decodeURIComponent(url.pathname);
    if (reqPath.startsWith('/api/')) {
      await handleApi(req, res, reqPath, url);
      return;
    }
    if (reqPath === '/health') {
      json(res, 200, { ok: true, online: users.size });
      return;
    }
    if (reqPath === '/') reqPath = '/index.html';
    const filePath = path.normalize(path.join(PUBLIC_DIR, reqPath));
    // Cegah directory traversal: file harus tetap di dalam public/.
    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',   // link undangan tidak bocor lewat header Referer
      'X-Frame-Options': 'DENY',
    });
    res.end(data);
  } catch {
    if (!res.headersSent) { res.writeHead(404); res.end('not found'); }
  }
};
const server = USE_TLS
  ? https.createServer({ cert: readFileSync(TLS_CERT), key: readFileSync(TLS_KEY) }, handler)
  : http.createServer(handler);

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD });
wss.on('connection', (ws, req) => {
  ws.host = String(req.headers.host ?? '').replace(/:\d+$/, '');
  ws.on('message', (raw) => handleMessage(ws, raw));
  ws.on('close', () => {
    const me = users.get(ws);
    if (!me) return;
    users.delete(ws);
    broadcast({ t: 'user_leave', id: me.id });
    console.log(`- ${me.name} keluar (${users.size} online)`);
  });
  ws.on('error', () => { /* biarkan 'close' yang menangani */ });
});

// ---------- mulai ----------
await loadTasks();
await loadFurniture();
await loadUndangan();
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} sudah dipakai program lain. Pakai port lain, mis. PORT=8096.`);
  else console.error('Server gagal berjalan:', err.message);
  process.exit(1);
});
server.listen(PORT, () => {
  const actual = server.address().port;
  const base = `${USE_TLS ? 'https' : 'http'}://localhost:${actual}`;
  console.log(`Kantor Virtual 3D berjalan di ${base}`);
  if (WAJIB_UNDANGAN) {
    console.log(`Kelola undangan (admin): ${base}/admin.html#kode=${undangan.admin}`);
    console.log(`Masuk kantor sebagai admin: ${base}/?undangan=${undangan.admin}`);
  } else {
    console.log('WAJIB_UNDANGAN=0: siapa pun yang tahu alamatnya bisa masuk.');
  }
});

// Berhenti dengan rapi (docker stop / Ctrl+C): simpan data, tutup koneksi.
let stopping = false;
async function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  console.log(`${sig} diterima, menyimpan dan berhenti…`);
  for (const ws of wss.clients) ws.close(1001, 'server berhenti');
  await Promise.all([...rantai.values()]);
  server.close();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
