// test/smoke.js — uji asap end-to-end untuk server Kantor Virtual 3D.
// Menjalankan server di port ephemeral, lalu memakai 2 klien WebSocket asli
// untuk memverifikasi: presence, pergerakan, chat, papan task, mode edit furnitur admin, dan leave.
// Keluar 0 jika semua lolos, 1 + pesan jelas jika ada yang gagal.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const ROOT = new URL('..', import.meta.url);
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-smoke-'));
const TASKS_FILE = path.join(tmpDir, 'tasks.json');
const FURNITURE_FILE = path.join(tmpDir, 'furniture.json');
const UNDANGAN_FILE = path.join(tmpDir, 'undangan.json');
const ADMIN = 'kode-admin-uji-123';

let child = null;
function fail(msg) {
  console.error(`GAGAL: ${msg}`);
  if (child) child.kill('SIGKILL');
  process.exit(1);
}
function ok(msg) { console.log(`  ok: ${msg}`); }

// --- klien uji ---
function makeClient(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const buf = [];
  ws.on('message', (d) => {
    try { buf.push(JSON.parse(d.toString())); } catch { /* abaikan */ }
  });
  return { ws, buf };
}

async function waitOpen(client, label) {
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout open ${label}`)), 8000);
    client.ws.on('open', () => { clearTimeout(t); resolve(); });
    client.ws.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

async function waitFor(client, pred, label, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const i = client.buf.findIndex(pred);
    if (i >= 0) return client.buf.splice(i, 1)[0];
    await new Promise((r) => setTimeout(r, 50));
  }
  fail(`timeout menunggu ${label}`);
}

async function main() {
  // --- 1. jalankan server di port ephemeral ---
  child = spawn(process.execPath, ['server.js'], {
    cwd: new URL(ROOT).pathname,
    env: {
      ...process.env,
      PORT: '0',
      TASKS_FILE,
      FURNITURE_FILE,
      ADMIN_PASSWORD: 'admin_test_pass',
      KODE_ADMIN: ADMIN,
      UNDANGAN_FILE,
      HTTPS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.on('error', (e) => fail(`server tidak bisa dijalankan: ${e.message}`));
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server tidak mencetak port')), 10000);
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
      const m = out.match(/localhost:(\d+)/);
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    });
  }).catch((e) => fail(e.message));
  console.log(`server berjalan di port ${port}`);

  const send = (c, o) => c.ws.send(JSON.stringify(o));
  const base = `http://127.0.0.1:${port}`;
  const api = (p, body, kode = ADMIN) => fetch(base + p, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-kode-admin': kode, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, data: await r.json() }));
  const buatUndangan = async (nama) => {
    const r = await api('/api/undangan', { nama, hari: 1 });
    if (r.status !== 200) fail(`gagal membuat undangan ${nama}: ${JSON.stringify(r)}`);
    return r.data.undangan.kode;
  };
  const kodeB = await buatUndangan('Budi');
  const kodeC = await buatUndangan('X'.repeat(40));

  // --- 2. dua klien join (nama kembar -> didedupe) ---
  const A = makeClient(port), B = makeClient(port);
  await waitOpen(A, 'A'); await waitOpen(B, 'B');
  send(A, { t: 'join', undangan: ADMIN, name: 'Budi' });
  const initA = await waitFor(A, (m) => m.t === 'init', 'init A');
  if (!initA.you?.id) fail('init A tidak berisi you.id');
  if (initA.users.length !== 1 || initA.users[0].name !== 'Budi') fail('init A: daftar users salah');
  if (!Array.isArray(initA.furniture) || initA.furniture.length === 0) fail('init A tidak berisi furnitur default');
  const idA = initA.you.id;
  ok('A join sebagai "Budi", init berisi daftar furnitur default');

  send(B, { t: 'join', undangan: kodeB, name: 'Penyamar' });
  const initB = await waitFor(B, (m) => m.t === 'init', 'init B');
  const bUser = initB.users.find((u) => u.id === initB.you.id);
  if (!bUser || bUser.name !== 'Budi (2)') fail(`dedupe nama gagal, dapat: ${bUser?.name}`);
  const idB = initB.you.id;
  ok('B (undangan Budi, mengaku "Penyamar") masuk sebagai "Budi (2)": nama terkunci + didedupe');

  const joinOnA = await waitFor(A, (m) => m.t === 'user_join', 'user_join di A');
  if (joinOnA.user?.name !== 'Budi (2)') fail('A tidak menerima user_join Budi (2)');
  ok('A menerima user_join untuk B');

  send(A, { t: 'rtc_signal', to: idB, signal: { description: { type: 'offer', sdp: 'test-sdp' } } });
  const signal = await waitFor(B, (m) => m.t === 'rtc_signal', 'rtc_signal di B');
  if (signal.from !== idA || signal.signal?.description?.sdp !== 'test-sdp') fail('relay RTC signal salah');
  if (A.buf.some((m) => m.t === 'rtc_signal')) fail('rtc_signal tidak boleh dibroadcast ke pengirim');
  ok('signaling RTC diteruskan hanya ke peer tujuan');

  send(A, { t: 'voice_status', active: true, speaking: true });
  const voiceSt = await waitFor(B, (m) => m.t === 'voice_status' && m.id === idA, 'voice_status di B');
  if (voiceSt.active !== true || voiceSt.speaking !== true) fail('payload voice_status salah');
  ok('voice_status (aktif & sedang bicara) disiarkan ke peer');

  // --- 3. pergerakan ---
  send(A, { t: 'move', x: 1.5, y: 0.75, z: 2.5, ry: 1.2, sitting: true });
  const mv = await waitFor(B, (m) => m.t === 'user_move' && m.id === idA, 'user_move di B');
  if (mv.x !== 1.5 || mv.y !== 0.75 || mv.z !== 2.5 || mv.sitting !== true) fail(`koordinat move salah: ${mv.x},${mv.y},${mv.z}`);
  ok('move A diteruskan ke B beserta tinggi dan pose duduk');

  // clamp: server harus membatasi ke dalam ruangan (bukan meneruskan 999)
  send(A, { t: 'move', x: 999, z: -999, ry: 0 });
  const mv2 = await waitFor(B, (m) => m.t === 'user_move' && m.id === idA, 'user_move clamp di B');
  if (mv2.x !== 17 || mv2.z !== -11) fail(`clamp tidak tepat: ${mv2.x},${mv2.z}`);
  ok('koordinat liar di-clamp ke dalam ruangan (17, -11)');

  // --- 4. chat ---
  send(A, { t: 'chat', text: 'halo tim' });
  const ch = await waitFor(B, (m) => m.t === 'chat' && m.id === idA, 'chat di B');
  if (ch.text !== 'halo tim' || ch.name !== 'Budi' || typeof ch.ts !== 'number') fail(`isi chat salah: ${JSON.stringify(ch)}`);
  ok('chat A diterima B lengkap (nama, teks, ts)');

  // --- 5. papan task: add -> move -> del ---
  send(A, { t: 'task_add', title: 'Siapkan mockup' });
  const tAddB = await waitFor(B, (m) => m.t === 'tasks' && m.tasks.length === 1, 'tasks(add) di B');
  const tAddA = await waitFor(A, (m) => m.t === 'tasks' && m.tasks.length === 1, 'tasks(add) di A');
  const task = tAddB.tasks[0];
  if (task.title !== 'Siapkan mockup' || task.col !== 'antri' || !task.id) fail(`task_add salah: ${JSON.stringify(task)}`);
  if (tAddA.tasks[0].id !== task.id) fail('id task tidak konsisten antara A dan B');
  ok('task_add disiarkan ke A dan B');
  const fileContent = await fs.readFile(TASKS_FILE, 'utf8').catch(() => fail('tasks.json tidak tertulis'));
  if (!fileContent.includes('Siapkan mockup')) fail('tasks.json tidak berisi task baru');
  ok('tasks.json tertulis ke disk');

  send(A, { t: 'task_move', id: task.id, col: 'dikerjakan' });
  const tMv = await waitFor(B, (m) => m.t === 'tasks' && m.tasks[0]?.col === 'dikerjakan', 'tasks(move) di B');
  if (tMv.tasks[0].id !== task.id) fail('task_move mengubah id');
  ok('task_move ke "dikerjakan" disiarkan');

  send(A, { t: 'task_del', id: task.id });
  await waitFor(A, (m) => m.t === 'tasks' && m.tasks.length === 0, 'tasks(del) di A');
  await waitFor(B, (m) => m.t === 'tasks' && m.tasks.length === 0, 'tasks(del) di B');
  ok('task_del disiarkan, daftar kosong kembali');

  // --- 6. Mode Edit Furnitur: Hak Akses Admin & CRUD Furnitur ---
  // Percobaan non-admin B mengubah furnitur -> ditolak/diabaikan
  send(B, { t: 'furniture_add', item: { id: 'f_hacker', type: 'plant', x: 0, y: 0, z: 0, ry: 0 } });
  await new Promise((r) => setTimeout(r, 200));
  if (A.buf.some((m) => m.t === 'furniture_add' && m.item?.id === 'f_hacker')) {
    fail('Non-admin berhasil menambah furnitur');
  }
  ok('Non-admin ditolak saat mencoba menambah furnitur');

  // Login Admin A gagal dengan password salah
  send(A, { t: 'admin_auth', key: 'wrong_password' });
  const authFail = await waitFor(A, (m) => m.t === 'admin_auth_result', 'admin_auth gagal di A');
  if (authFail.success !== false) fail('Password salah diterima sebagai admin');
  ok('Login admin dengan kata sandi salah ditolak');

  // Login Admin A berhasil
  send(A, { t: 'admin_auth', key: 'admin_test_pass' });
  const authSuccess = await waitFor(A, (m) => m.t === 'admin_auth_result', 'admin_auth sukses di A');
  if (authSuccess.success !== true) fail('Password admin valid ditolak');
  ok('Login admin A berhasil diverifikasi');

  // Admin A menambah furnitur baru (misal: plant di tengah ruangan)
  const newFurn = { id: 'f_test_plant_1', type: 'plant', x: 2.5, y: 0, z: 3.5, ry: 0 };
  send(A, { t: 'furniture_add', item: newFurn });
  const fAddA = await waitFor(A, (m) => m.t === 'furniture_add' && m.item.id === 'f_test_plant_1', 'furniture_add di A');
  const fAddB = await waitFor(B, (m) => m.t === 'furniture_add' && m.item.id === 'f_test_plant_1', 'furniture_add di B');
  if (fAddA.item.x !== 2.5 || fAddB.item.z !== 3.5) fail('Data furniture_add tidak sesuai');
  ok('Admin A menambah furnitur -> disiarkan real-time ke semua klien');

  // Admin A menggeser / memutar furnitur
  const updatedFurn = { ...newFurn, x: 4.0, z: 5.0, ry: 1.57 };
  send(A, { t: 'furniture_update', item: updatedFurn });
  const fUpdB = await waitFor(B, (m) => m.t === 'furniture_update' && m.item.id === 'f_test_plant_1', 'furniture_update di B');
  if (fUpdB.item.x !== 4.0 || fUpdB.item.z !== 5.0 || fUpdB.item.ry !== 1.57) fail('Data furniture_update salah');
  ok('Admin A menggeser & memutar furnitur -> tersinkronisasi ke klien lain');

  // Persistensi furnitur di disk
  const furnFileContent = await fs.readFile(FURNITURE_FILE, 'utf8').catch(() => fail('furniture.json tidak tersimpan'));
  if (!furnFileContent.includes('f_test_plant_1')) fail('furniture.json tidak menyimpan furnitur baru');
  ok('Perubahan furnitur tersimpan secara persisten di disk');

  // Admin A menghapus furnitur
  send(A, { t: 'furniture_delete', id: 'f_test_plant_1' });
  await waitFor(A, (m) => m.t === 'furniture_delete' && m.id === 'f_test_plant_1', 'furniture_delete di A');
  await waitFor(B, (m) => m.t === 'furniture_delete' && m.id === 'f_test_plant_1', 'furniture_delete di B');
  ok('Admin A menghapus furnitur -> disiarkan ke semua klien');

  // Admin A mereset furnitur ke default
  send(A, { t: 'furniture_reset' });
  const fResetA = await waitFor(A, (m) => m.t === 'furniture_reset', 'furniture_reset di A');
  const fResetB = await waitFor(B, (m) => m.t === 'furniture_reset', 'furniture_reset di B');
  if (!Array.isArray(fResetA.furniture) || fResetA.furniture.length === 0) fail('furniture_reset kosong');
  ok('Admin A mereset tata letak furnitur -> disiarkan ke semua klien');

  // --- 7. Fitur Kick Pengguna oleh Admin ---
  // Non-admin B mencoba kick A -> ditolak
  send(B, { t: 'kick', id: idA });
  const errKick = await waitFor(B, (m) => m.t === 'error', 'error kick di B');
  if (!errKick.message.includes('admin')) fail('Non-admin kick tidak menghasilkan pesan error admin');
  ok('Non-admin ditolak saat mencoba kick pengguna');

  // Admin A kick B
  send(A, { t: 'kick', id: idB, reason: 'Uji coba kick' });
  const kickedB = await waitFor(B, (m) => m.t === 'kicked', 'kicked di B');
  if (kickedB.reason !== 'Uji coba kick') fail('Alasan kick tidak sesuai');
  const leaveB = await waitFor(A, (m) => m.t === 'user_leave' && m.id === idB, 'user_leave di A');
  if (!leaveB) fail('Admin A tidak menerima user_leave setelah kick');
  ok('Admin A kick B -> B menerima pesan kicked dan koneksi terputus');

  // --- 8. nama terlalu panjang dipotong ---
  const C = makeClient(port);
  await waitOpen(C, 'C');
  send(C, { t: 'join', undangan: kodeC, name: 'apa saja' });
  const initC = await waitFor(C, (m) => m.t === 'init', 'init C');
  const cName = initC.users.find((u) => u.id === initC.you.id)?.name;
  if (!cName || cName.length > 20) fail(`sanitasi nama gagal: panjang ${cName?.length}`);
  ok(`nama 40 karakter dipotong jadi ${cName.length} karakter`);
  C.ws.close();

  // --- 9. leave ---
  const lvC = await waitFor(A, (m) => m.t === 'user_leave' && m.id === initC.you.id, 'user_leave C di A');
  if (!lvC) fail('user_leave C tidak diterima');
  ok('C disconnect -> A menerima user_leave');

  // --- 10. keamanan: tanpa undangan, admin123, pesan raksasa, cabut ---
  const D = makeClient(port);
  await waitOpen(D, 'D');
  send(D, { t: 'join', name: 'Penyusup' });
  await waitFor(D, (m) => m.t === 'kicked', 'kicked tanpa undangan');
  ok('tanpa undangan -> ditolak');

  const E = makeClient(port);
  await waitOpen(E, 'E');
  send(E, { t: 'join', name: 'Iseng', adminCode: 'admin123' });
  await waitFor(E, (m) => m.t === 'kicked', 'kicked dengan admin123');
  if ((await api('/api/undangan', null, 'admin123')).status !== 401) fail('admin123 diterima API admin');
  ok('kata sandi lama "admin123" tidak berlaku lagi');

  const kodeF = await buatUndangan('Fajar');
  const F = makeClient(port);
  await waitOpen(F, 'F');
  send(F, { t: 'join', undangan: kodeF, name: 'Fajar' });
  await waitFor(F, (m) => m.t === 'init', 'init F');
  send(F, { t: 'admin_auth', key: 'admin123' });
  const authF = await waitFor(F, (m) => m.t === 'admin_auth_result', 'admin_auth F');
  if (authF.success) fail('tamu bisa jadi admin dengan admin123');
  send(F, { t: 'kick', id: idA });
  await waitFor(F, (m) => m.t === 'error', 'error kick oleh tamu');
  ok('tamu tidak bisa jadi admin lewat "/admin" / admin123, kick ditolak');

  const fClosed = new Promise((r) => F.ws.on('close', (c) => r(c)));
  F.ws.send(JSON.stringify({ t: 'chat', text: 'x'.repeat(100000) }));
  const codeF = await Promise.race([fClosed, new Promise((r) => setTimeout(() => r('timeout'), 5000))]);
  if (codeF !== 1009) fail(`pesan raksasa seharusnya ditolak (1009), dapat ${codeF}`);
  ok('pesan >64KB ditolak (1009), server tetap hidup');

  const G = makeClient(port);
  await waitOpen(G, 'G');
  send(G, { t: 'join', undangan: kodeF, name: 'Fajar' });
  await waitFor(G, (m) => m.t === 'init', 'init G');
  const gClosed = new Promise((r) => G.ws.on('close', (c) => r(c)));
  if ((await api('/api/undangan/cabut', { kode: kodeF })).status !== 200) fail('cabut gagal');
  await waitFor(G, (m) => m.t === 'kicked', 'kicked setelah dicabut');
  if (await gClosed !== 4001) fail('koneksi Fajar seharusnya ditutup');
  const cek = await fetch(`${base}/api/cek?undangan=${kodeF}`).then((r) => r.json());
  if (cek.sah) fail('undangan dicabut masih dianggap sah');
  ok('cabut undangan -> tamu langsung dikeluarkan dan link mati');

  send(A, { t: 'furniture_add', item: { id: '<img onerror=1>', type: 'plant"><script>', x: 1e9, z: 0 } });
  send(A, { t: 'furniture_add', item: { type: 'plant', x: 1e9, z: -1e9, opts: { w: 2, jahat: { a: 1 } } } });
  const fa = await waitFor(A, (m) => m.t === 'furniture_add', 'furniture_add tervalidasi');
  if (fa.item.type !== 'plant' || fa.item.x > 20 || fa.item.z < -20 || fa.item.opts.jahat !== undefined) fail(`furnitur tidak divalidasi: ${JSON.stringify(fa.item)}`);
  ok('furnitur dari admin divalidasi (tipe, posisi, opts)');

  const tersimpan = JSON.parse(await fs.readFile(UNDANGAN_FILE, 'utf8'));
  if (tersimpan.admin !== ADMIN || !tersimpan.daftar.some((u) => u.kode === kodeF && u.dicabut)) fail('undangan.json tidak tersimpan benar');
  ok('undangan.json tersimpan');

  A.ws.close();
  await new Promise((r) => setTimeout(r, 300));
  const exitCode = new Promise((r) => child.on('exit', (c) => r(c)));
  child.kill('SIGTERM');
  const ec = await Promise.race([exitCode, new Promise((r) => setTimeout(() => r('timeout'), 4000))]);
  if (ec !== 0) fail(`server tidak berhenti rapi (exit ${ec})`);
  ok('SIGTERM -> berhenti rapi');
  console.log('\nSEMUA UJI LOLOS');
  process.exit(0);
}

main().catch((e) => fail(e.message));
