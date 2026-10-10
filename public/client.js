// client.js — klien 3D Kantor Virtual (Three.js via CDN, tanpa build step).
// Denah multi-ruang: Multipurpose, Meeting, Pantry, Relax, Head 1/2, Office, Boss, Toilet + koridor.
// Dilengkapi Mode Edit interaktif untuk Admin (penempatan, rotasi, penambahan dari katalog, penghapusan, duplikasi).
import * as THREE from 'three';

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const sceneBox = $('scene');
const joinOverlay = $('joinOverlay'), nameInput = $('nameInput'), joinBtn = $('joinBtn'), joinInfo = $('joinInfo');
let myInvite = '';      // kode undangan dari link (?undangan=...)
let wantOnline = false; // true setelah klik Masuk: terus coba sambung ulang
let retryDelay = 1000;
const reconnectOverlay = $('reconnectOverlay');
const userList = $('userList'), userCount = $('userCount');
const chatList = $('chatList'), chatInput = $('chatInput');
const boardBtn = $('boardBtn'), kanbanModal = $('kanbanModal'), kanbanCols = $('kanbanCols'), kanbanClose = $('kanbanClose');
const interactionPrompt = $('interactionPrompt');
const voiceBtn = $('voiceBtn');
const toasts = $('toasts');

// DOM Mode Edit & Admin
const editBtn = $('editBtn');
const editorBar = $('editorBar');
const selectedItemLabel = $('selectedItemLabel');
const addFurnBtn = $('addFurnBtn');
const rotateFurnBtn = $('rotateFurnBtn');
const dupFurnBtn = $('dupFurnBtn');
const delFurnBtn = $('delFurnBtn');
const resetFurnBtn = $('resetFurnBtn');
const closeEditBtn = $('closeEditBtn');

const adminModal = $('adminModal');
const adminKeyInput = $('adminKeyInput');
const adminLoginBtn = $('adminLoginBtn');
const adminCloseBtn = $('adminCloseBtn');

const catalogModal = $('catalogModal');
const catalogList = $('catalogList');
const catalogCloseBtn = $('catalogCloseBtn');

// ---------- state ----------
let socket = null;
let joined = false;
let isAdmin = false;
let isEditMode = false;
let roomLocked = false;
let voiceDisabled = false;
let myId = null, myName = '', myColor = '#3498db';
const users = new Map(); // id -> { data, group, tag, tx, ty, tz, try_, micActive, speaking, volume }
const peerConnections = new Map();
const remoteAudio = new Map(); // peerId -> { source, analyser, gain, panner, stream, freqData }
const remoteAudioElements = new Map(); // peerId -> HTMLAudioElement
const VOICE_RANGE = 28;
let localStream = null, audioContext = null;
let localAnalyser = null, localSource = null, localFreqData = null;
let isSpeakingLocal = false;
let lastVoiceAnimUpdate = 0;
let lastVoiceStatusSent = 0;
let tasks = [];
const TASK_COLS = [
  { id: 'antri', label: 'ANTRI' },
  { id: 'dikerjakan', label: 'DIKERJAKAN' },
  { id: 'selesai', label: 'SELESAI' },
];

// Furnitur State
let furnitureList = []; // Array furnitur mentah dari server [{ id, type, x, y, z, ry, opts }]
const furnitureObjects = new Map(); // id -> { item, group, colliders, interactables }
let selectedFurnId = null;
let isDraggingFurn = false;
let dragPlaneOffset = new THREE.Vector3();

const player = { x: -8, y: 0, z: 6, ry: Math.PI / 2, sitting: false, seat: null };
const keys = {};
const ROOM_X = 17, ROOM_Z = 11; // sama dengan server (lantai 34 x 22 m)
const SPEED = 4; // meter/detik
const GRAVITY = 15, JUMP_SPEED = 6.2;
let jumpVelocity = 0, lastMoveSent = 0;
let lastSentPose = { x: player.x, y: 0, z: player.z, ry: player.ry, sitting: false };
let camZoom = 1;
let camAzimuth = 0;
let camElevation = Math.atan2(13.5, 10);
let orbitPointer = null;

// ---------- three.js dasar ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.domElement.style.touchAction = 'none';
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
sceneBox.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2b3542);
scene.fog = new THREE.Fog(0x2b3542, 45, 110);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 220);

const hemi = new THREE.HemisphereLight(0xfff6e8, 0x8a7a66, 0.9);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(18, 26, 14);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -24; sun.shadow.camera.right = 24;
sun.shadow.camera.top = 20; sun.shadow.camera.bottom = -20;
sun.shadow.camera.far = 90;
scene.add(sun);

// Cincin seleksi furnitur 3D
const selectionRingGeo = new THREE.RingGeometry(0.55, 0.72, 32);
const selectionRingMat = new THREE.MeshBasicMaterial({ color: 0x00f0ff, side: THREE.DoubleSide, transparent: true, opacity: 0.85 });
const selectionRing = new THREE.Mesh(selectionRingGeo, selectionRingMat);
selectionRing.rotation.x = -Math.PI / 2;
selectionRing.position.y = 0.035;
selectionRing.visible = false;
scene.add(selectionRing);

// Raycasting untuk seleksi dan drag furnitur
const raycaster = new THREE.Raycaster();
const mouseVec = new THREE.Vector2();
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const planeIntersectPoint = new THREE.Vector3();

// ---------- Katalog Furnitur ----------
const FURNITURE_CATALOG = [
  { type: 'workstation', name: 'Workstation Komplit', category: 'Meja & Kerja', icon: '💻', desc: 'Meja + Laptop + Kursi Putar' },
  { type: 'desk', name: 'Meja Kerja Polos', category: 'Meja & Kerja', icon: '🪑', desc: 'Meja kerja kayu' },
  { type: 'meeting_table', name: 'Meja Konferensi', category: 'Meja & Kerja', icon: '📊', desc: 'Meja rapat besar' },
  { type: 'chair_blue', name: 'Kursi Putar Biru', category: 'Kursi & Duduk', icon: '🪑', desc: 'Kursi ergonomis biru' },
  { type: 'chair_black', name: 'Kursi Putar Hitam', category: 'Kursi & Duduk', icon: '🪑', desc: 'Kursi ergonomis hitam' },
  { type: 'sofa', name: 'Sofa Santai', category: 'Kursi & Duduk', icon: '🛋️', desc: 'Sofa nyaman 3 dudukan' },
  { type: 'beanbag_red', name: 'Beanbag Merah', category: 'Kursi & Duduk', icon: '🔴', desc: 'Dudukan empuk merah' },
  { type: 'beanbag_blue', name: 'Beanbag Biru', category: 'Kursi & Duduk', icon: '🔵', desc: 'Dudukan empuk biru' },
  { type: 'coffee_table', name: 'Meja Kopi', category: 'Kursi & Duduk', icon: '☕', desc: 'Meja santai rendah' },
  { type: 'bookshelf', name: 'Rak Buku', category: 'Perabot & Dekorasi', icon: '📚', desc: 'Rak buku dengan koleksi buku' },
  { type: 'cabinet', name: 'Lemari Kabinet', category: 'Perabot & Dekorasi', icon: '🗄️', desc: 'Lemari kayu arsip' },
  { type: 'rug', name: 'Karpet Santai', category: 'Perabot & Dekorasi', icon: '🧶', desc: 'Karpet lantai area santai' },
  { type: 'plant', name: 'Tanaman Hias', category: 'Perabot & Dekorasi', icon: '🪴', desc: 'Pot tanaman indoor segar' },
  { type: 'tv', name: 'Smart TV Dinding', category: 'Elektronik & Utilitas', icon: '📺', desc: 'Layar TV presentasi' },
  { type: 'ac', name: 'AC Split Dinding', category: 'Elektronik & Utilitas', icon: '❄️', desc: 'Unit AC pendingin' },
  { type: 'clock', name: 'Jam Dinding', category: 'Elektronik & Utilitas', icon: '⏰', desc: 'Jam dinding analog' },
  { type: 'printer', name: 'Mesin Printer', category: 'Elektronik & Utilitas', icon: '🖨️', desc: 'Stasiun printer dan rak' },
  { type: 'laptop', name: 'Laptop Terbuka', category: 'Elektronik & Utilitas', icon: '💻', desc: 'Laptop di atas meja' },
  { type: 'kitchen_counter', name: 'Kitchen Counter', category: 'Pantry & Toilet', icon: '🍽️', desc: 'Meja dapur + wastafel + rak' },
  { type: 'fridge', name: 'Kulkas 2 Pintu', category: 'Pantry & Toilet', icon: '🧊', desc: 'Kulkas kantor putih' },
  { type: 'dispenser', name: 'Dispenser Air', category: 'Pantry & Toilet', icon: '💧', desc: 'Dispenser air galon' },
  { type: 'sink', name: 'Wastafel', category: 'Pantry & Toilet', icon: '🚰', desc: 'Wastafel keramik putih' },
  { type: 'toilet_bowl', name: 'Kloset Duduk', category: 'Pantry & Toilet', icon: '🚽', desc: 'Kloset duduk putih' },
  { type: 'prayer_mat', name: 'Sajadah', category: 'Musholla', icon: '🕌', desc: 'Sajadah sholat' },
  { type: 'mihrab', name: 'Mihrab Dinding', category: 'Musholla', icon: '🌙', desc: 'Penanda arah kiblat' },
];

function getFurnitureName(type) {
  const f = FURNITURE_CATALOG.find((c) => c.type === type);
  return f ? f.name : type;
}

// ---------- util bangun & collider ----------
const staticColliders = [];
let dynamicColliders = []; // { furnId, x0, x1, z0, z1, top }
let dynamicInteractables = []; // { furnId, x, z, label, action, ry, seatHeight }

function addStaticCollider(x0, x1, z0, z1, top = Infinity) {
  staticColliders.push({ x0, x1, z0, z1, top });
}

// Kotak dengan collider statis otomatis (untuk dinding & batas ruangan).
function solidBox(w, h, d, mat, x, y, z, collide = true) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = true;
  scene.add(m);
  if (collide) addStaticCollider(x - w / 2, x + w / 2, z - d / 2, z + d / 2, y + h / 2);
  return m;
}

// Kotak dekoratif tanpa collider.
function box(w, h, d, color, x, y, z, opts = {}) {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...(opts.emissive ? { emissive: opts.emissive, emissiveIntensity: opts.ei ?? 1 } : {}) }),
  );
  m.position.set(x, y, z);
  m.castShadow = opts.cast ?? true;
  m.receiveShadow = opts.receive ?? true;
  scene.add(m);
  return m;
}

function nearestInteractable() {
  let nearest = null, nearestDistance = 1.65;
  for (const item of dynamicInteractables) {
    const distance = Math.hypot(item.x - player.x, item.z - player.z);
    if (distance < nearestDistance) { nearest = item; nearestDistance = distance; }
  }
  return nearest;
}

function findClearSpot(originX, originZ, preferredAngle = 0) {
  const angles = [
    preferredAngle,
    preferredAngle + 0.4,
    preferredAngle - 0.4,
    preferredAngle + Math.PI / 2,
    preferredAngle - Math.PI / 2,
    preferredAngle + Math.PI,
    0, Math.PI / 2, Math.PI, -Math.PI / 2,
    Math.PI / 4, -Math.PI / 4, 3 * Math.PI / 4, -3 * Math.PI / 4,
  ];
  const dists = [0.85, 1.1, 1.35, 1.6, 0.65];
  for (const d of dists) {
    for (const a of angles) {
      const testX = originX + Math.sin(a) * d;
      const testZ = originZ + Math.cos(a) * d;
      if (!hit(testX, testZ, 0)) {
        return { x: testX, z: testZ };
      }
    }
  }
  return null;
}

function unstick(px, pz, py = 0) {
  if (!hit(px, pz, py)) return { x: px, z: pz };
  for (let r = 0.05; r <= 1.2; r += 0.05) {
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
      const testX = px + Math.cos(a) * r;
      const testZ = pz + Math.sin(a) * r;
      if (!hit(testX, testZ, py)) {
        return { x: testX, z: testZ };
      }
    }
  }
  return { x: px, z: pz };
}

function standUp() {
  if (!player.sitting) return;
  const seat = player.seat;
  player.sitting = false;
  player.seat = null;
  player.y = 0;
  if (seat) {
    const spot = findClearSpot(seat.x, seat.z, seat.ry);
    if (spot) {
      player.x = spot.x;
      player.z = spot.z;
    }
  }
}

function interact() {
  if (isEditMode) return; // Mode edit mematikan interaksi duduk biasa
  if (player.sitting) { standUp(); return; }
  const item = nearestInteractable();
  if (!item) return;
  if (item.action === 'seat') {
    player.x = item.x; player.z = item.z; player.ry = item.ry;
    player.y = item.seatHeight; player.sitting = true; player.seat = item;
    return;
  }
  if (item.action === 'board') {
    renderKanban(); kanbanModal.classList.remove('hidden');
    return;
  }
  toast(item.label);
}

function hit(x, z, y = 0) {
  if (Math.abs(x) > ROOM_X || Math.abs(z) > ROOM_Z) return true;
  const r = 0.35;
  // Periksa collider statis (dinding)
  for (const c of staticColliders) {
    if (y >= c.top) continue;
    const cx = Math.max(c.x0, Math.min(x, c.x1));
    const cz = Math.max(c.z0, Math.min(z, c.z1));
    const dx = x - cx, dz = z - cz;
    if (dx * dx + dz * dz < r * r) return true;
  }
  // Periksa collider dinamis furnitur
  for (const c of dynamicColliders) {
    if (y >= c.top) continue;
    const cx = Math.max(c.x0, Math.min(x, c.x1));
    const cz = Math.max(c.z0, Math.min(z, c.z1));
    const dx = x - cx, dz = z - cz;
    if (dx * dx + dz * dz < r * r) return true;
  }
  return false;
}

// ---------- material bersama ----------
const M = {
  wood: new THREE.MeshStandardMaterial({ color: 0xb98a5a, roughness: 0.75 }),
  woodDark: new THREE.MeshStandardMaterial({ color: 0x7a5c3d, roughness: 0.8 }),
  white: new THREE.MeshStandardMaterial({ color: 0xf5f5f3, roughness: 0.6 }),
  chairBlue: new THREE.MeshStandardMaterial({ color: 0x2a4d8f, roughness: 0.8 }),
  chairBlack: new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.8 }),
  metal: new THREE.MeshStandardMaterial({ color: 0x555b62, roughness: 0.5, metalness: 0.4 }),
  screen: new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0x9fd8e8, emissiveIntensity: 0.8 }),
  tvScreen: new THREE.MeshStandardMaterial({ color: 0x0a0f14, emissive: 0x3a6ea5, emissiveIntensity: 0.55 }),
  wall: new THREE.MeshStandardMaterial({ color: 0xcfe3d6, roughness: 0.9 }),
  door: new THREE.MeshStandardMaterial({ color: 0xa0714f, roughness: 0.7 }),
  cabinet: new THREE.MeshStandardMaterial({ color: 0x8a9aa5, roughness: 0.6, metalness: 0.15 }),
  counterTop: new THREE.MeshStandardMaterial({ color: 0xe8e6e0, roughness: 0.4 }),
  bottleBlue: new THREE.MeshStandardMaterial({ color: 0x4aa3df, roughness: 0.3, transparent: true, opacity: 0.85 }),
};

// Lantai ubin putih prosedural.
function tileTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const c = cv.getContext('2d');
  c.fillStyle = '#f5f5f3'; c.fillRect(0, 0, 256, 256);
  c.fillStyle = 'rgba(0,0,0,0.025)';
  for (let i = 0; i < 36; i++) c.fillRect(Math.random() * 256, Math.random() * 256, 3, 3);
  c.strokeStyle = '#c2c2c0'; c.lineWidth = 4;
  c.strokeRect(2, 2, 124, 124);
  c.strokeRect(130, 2, 124, 124);
  c.strokeRect(2, 130, 124, 124);
  c.strokeRect(130, 130, 124, 124);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(17, 11); // lantai 34 x 22 m -> ubin 1 m
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------- dinding statis ----------
const WALL_H = 2.8, WALL_T = 0.3;

function wallSegH(x0, x1, z) {
  const w = x1 - x0;
  if (w <= 0.01) return;
  solidBox(w, WALL_H, WALL_T, M.wall, (x0 + x1) / 2, WALL_H / 2, z);
}
function wallSegV(z0, z1, x) {
  const d = z1 - z0;
  if (d <= 0.01) return;
  solidBox(WALL_T, WALL_H, d, M.wall, x, WALL_H / 2, (z0 + z1) / 2);
}

function wallH(x0, x1, z, gaps = []) {
  let cur = x0;
  for (const [a, b] of [...gaps].sort((p, q) => p[0] - q[0])) {
    wallSegH(cur, a, z);
    doorLeaf(a + 0.05, z, false);
    cur = b;
  }
  wallSegH(cur, x1, z);
}
function wallV(z0, z1, x, gaps = []) {
  let cur = z0;
  for (const [a, b] of [...gaps].sort((p, q) => p[0] - q[0])) {
    wallSegV(cur, a, x);
    doorLeaf(x, a + 0.05, true);
    cur = b;
  }
  wallSegV(cur, z1, x);
}

function doorLeaf(x, z, alongZ) {
  const g = new THREE.Group();
  const leaf = new THREE.Mesh(new THREE.BoxGeometry(1.02, 2.1, 0.06), M.door);
  leaf.position.x = 0.51;
  leaf.castShadow = true;
  g.add(leaf);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), M.metal);
  knob.position.set(0.9, 0, 0.07);
  g.add(knob);
  g.position.set(x, 1.05, z);
  g.rotation.y = (alongZ ? Math.PI / 2 : 0) + 0.55;
  scene.add(g);
}

function roomPlate(text, x, y, z, ry) {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 128;
  const c = cv.getContext('2d');
  c.fillStyle = '#22303c'; c.fillRect(0, 0, 512, 128);
  c.strokeStyle = '#f0c75e'; c.lineWidth = 6; c.strokeRect(8, 8, 496, 112);
  c.fillStyle = '#ffffff'; c.font = 'bold 46px sans-serif';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(text, 256, 68);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(2.3, 0.575),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 }),
  );
  m.position.set(x, y, z);
  m.rotation.y = ry;
  scene.add(m);
}

// Lampu neon gantung (rumah + tabung menyala + tali).
const tubeHouseGeo = new THREE.BoxGeometry(1.9, 0.09, 0.3);
const tubeHouseMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e6, roughness: 0.6 });
const tubeGeo = new THREE.BoxGeometry(1.8, 0.07, 0.22);
const tubeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xf4fbff, emissiveIntensity: 1.6 });
const rodGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.9, 6);
const rodMat = new THREE.MeshStandardMaterial({ color: 0x555b62 });
function buildTubeLight(x, z) {
  const y = 3.1;
  const house = new THREE.Mesh(tubeHouseGeo, tubeHouseMat);
  house.position.set(x, y + 0.06, z);
  scene.add(house);
  const tube = new THREE.Mesh(tubeGeo, tubeMat);
  tube.position.set(x, y, z);
  scene.add(tube);
  for (const ox of [-0.7, 0.7]) {
    const rod = new THREE.Mesh(rodGeo, rodMat);
    rod.position.set(x + ox, y + 0.5, z);
    scene.add(rod);
  }
}

// ============================================================================
// SISTEM FURNITUR DINAMIS & INTERAKTIF (3D)
// ============================================================================

function tagFurnMesh(meshOrGroup, furnId) {
  meshOrGroup.traverse((child) => {
    if (child.isMesh || child.isGroup) {
      child.userData.furnitureId = furnId;
    }
  });
}

// Pembangun objek 3D untuk tiap jenis furnitur
function instantiateFurniture(f) {
  const g = new THREE.Group();
  const colls = [];
  const inters = [];
  const x = Number(f.x) || 0;
  const y = Number(f.y) || 0;
  const z = Number(f.z) || 0;
  const ry = Number(f.ry) || 0;
  const opts = f.opts || {};

  switch (f.type) {
    case 'chair_blue':
    case 'chair_black': {
      const color = f.type === 'chair_blue' ? 0x2a4d8f : 0x23262b;
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
      const seat = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.1, 0.55), mat);
      seat.position.y = 0.48; seat.castShadow = true; g.add(seat);
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.65, 0.1), mat);
      back.position.set(0, 0.85, -0.26); back.castShadow = true; g.add(back);
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.45, 10), M.metal);
      stem.position.y = 0.24; g.add(stem);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.32, 0.06, 12), M.metal);
      base.position.y = 0.04; g.add(base);
      colls.push({ furnId: f.id, x0: x - 0.33, x1: x + 0.33, z0: z - 0.33, z1: z + 0.33, top: y + 1.2 });
      inters.push({ furnId: f.id, x, z, label: 'Duduk di kursi', action: 'seat', ry, seatHeight: 0.2 });
      break;
    }

    case 'desk': {
      const w = opts.w || 1.4, d = opts.d || 0.9;
      const top = new THREE.Mesh(new THREE.BoxGeometry(w, 0.07, d), M.wood);
      top.position.y = 0.72; top.castShadow = true; top.receiveShadow = true; g.add(top);
      if (w >= d) {
        const leg1 = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.68, d - 0.12), M.woodDark);
        leg1.position.set(-w / 2 + 0.06, 0.34, 0); leg1.castShadow = true; g.add(leg1);
        const leg2 = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.68, d - 0.12), M.woodDark);
        leg2.position.set(w / 2 - 0.06, 0.34, 0); leg2.castShadow = true; g.add(leg2);
      } else {
        const leg1 = new THREE.Mesh(new THREE.BoxGeometry(w - 0.12, 0.68, 0.07), M.woodDark);
        leg1.position.set(0, 0.34, -d / 2 + 0.06); leg1.castShadow = true; g.add(leg1);
        const leg2 = new THREE.Mesh(new THREE.BoxGeometry(w - 0.12, 0.68, 0.07), M.woodDark);
        leg2.position.set(0, 0.34, d / 2 - 0.06); leg2.castShadow = true; g.add(leg2);
      }
      const cos = Math.abs(Math.cos(ry)), sin = Math.abs(Math.sin(ry));
      const effW = w * cos + d * sin, effD = w * sin + d * cos;
      colls.push({ furnId: f.id, x0: x - effW / 2, x1: x + effW / 2, z0: z - effD / 2, z1: z + effD / 2, top: y + 0.78 });
      inters.push({ furnId: f.id, x, z, label: 'Bekerja di meja' });
      break;
    }

    case 'workstation': {
      const w = opts.w || 1.8, d = opts.d || 1.0;
      const chairColor = opts.color || 0x2a4d8f;
      // Meja
      const top = new THREE.Mesh(new THREE.BoxGeometry(w, 0.07, d), M.wood);
      top.position.y = 0.72; top.castShadow = true; g.add(top);
      const leg1 = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.68, d - 0.12), M.woodDark);
      leg1.position.set(-w / 2 + 0.06, 0.34, 0); g.add(leg1);
      const leg2 = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.68, d - 0.12), M.woodDark);
      leg2.position.set(w / 2 - 0.06, 0.34, 0); g.add(leg2);
      // Laptop
      const lapBase = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.03, 0.26), M.chairBlack);
      lapBase.position.set(0, 0.77, 0); lapBase.castShadow = true; g.add(lapBase);
      const lapLid = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.25, 0.025), M.chairBlack);
      lapLid.position.set(0, 0.89, -0.115); lapLid.rotation.x = -0.3; g.add(lapLid);
      const lapScr = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.21), M.screen);
      lapScr.position.set(0, 0.895, -0.1); lapScr.rotation.x = -0.3; g.add(lapScr);
      // Kursi
      const cMat = new THREE.MeshStandardMaterial({ color: chairColor, roughness: 0.8 });
      const cSeat = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.1, 0.55), cMat);
      cSeat.position.set(0, 0.48, d / 2 + 0.35); cSeat.castShadow = true; g.add(cSeat);
      const cBack = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.65, 0.1), cMat);
      cBack.position.set(0, 0.85, d / 2 + 0.35 + 0.26); cBack.castShadow = true; g.add(cBack);
      const cStem = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.45, 10), M.metal);
      cStem.position.set(0, 0.24, d / 2 + 0.35); g.add(cStem);
      const cBase = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.32, 0.06, 12), M.metal);
      cBase.position.set(0, 0.04, d / 2 + 0.35); g.add(cBase);

      const cos = Math.abs(Math.cos(ry)), sin = Math.abs(Math.sin(ry));
      const effW = w * cos + (d + 0.7) * sin, effD = w * sin + (d + 0.7) * cos;
      colls.push({ furnId: f.id, x0: x - effW / 2, x1: x + effW / 2, z0: z - effD / 2, z1: z + effD / 2, top: y + 1.2 });
      const chairOffZ = (d / 2 + 0.35);
      const chairWorldX = x + Math.sin(ry) * chairOffZ;
      const chairWorldZ = z + Math.cos(ry) * chairOffZ;
      inters.push({ furnId: f.id, x: chairWorldX, z: chairWorldZ, label: 'Duduk bekerja', action: 'seat', ry, seatHeight: 0.2 });
      break;
    }

    case 'meeting_table': {
      const top = new THREE.Mesh(new THREE.BoxGeometry(8, 0.08, 2), M.wood);
      top.position.y = 0.72; top.castShadow = true; g.add(top);
      const leg1 = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.68, 1.7), M.woodDark);
      leg1.position.set(-2.8, 0.34, 0); g.add(leg1);
      const leg2 = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.68, 1.7), M.woodDark);
      leg2.position.set(3.8, 0.34, 0); g.add(leg2);

      const cos = Math.abs(Math.cos(ry)), sin = Math.abs(Math.sin(ry));
      const effW = 8 * cos + 2 * sin, effD = 8 * sin + 2 * cos;
      colls.push({ furnId: f.id, x0: x - effW / 2, x1: x + effW / 2, z0: z - effD / 2, z1: z + effD / 2, top: y + 0.78 });
      inters.push({ furnId: f.id, x, z, label: 'Mulai rapat di meja' });
      break;
    }

    case 'sofa': {
      const mat = new THREE.MeshStandardMaterial({ color: 0x7a9e7e, roughness: 0.92 });
      const base = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.42, 0.95), mat);
      base.position.y = 0.31; base.castShadow = true; g.add(base);
      const back = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.72, 0.24), mat);
      back.position.set(0, 0.68, -0.355); back.castShadow = true; g.add(back);
      for (const s of [-1, 1]) {
        const arm = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.62, 0.95), mat);
        arm.position.set(s * 1.08, 0.52, 0); arm.castShadow = true; g.add(arm);
        const cushion = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.14, 0.5),
          new THREE.MeshStandardMaterial({ color: 0xf0e6d2, roughness: 0.95 }));
        cushion.position.set(s * 0.55, 0.58, 0.08); cushion.castShadow = true; g.add(cushion);
      }
      const cos = Math.abs(Math.cos(ry)), sin = Math.abs(Math.sin(ry));
      const effW = 2.4 * cos + 0.95 * sin, effD = 2.4 * sin + 0.95 * cos;
      colls.push({ furnId: f.id, x0: x - effW / 2, x1: x + effW / 2, z0: z - effD / 2, z1: z + effD / 2, top: y + 1.05 });
      inters.push({ furnId: f.id, x, z, label: 'Duduk di sofa', action: 'seat', ry, seatHeight: 0.15 });
      break;
    }

    case 'coffee_table': {
      const top = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.38, 0.7), M.wood);
      top.position.y = 0.19; top.castShadow = true; g.add(top);
      const cos = Math.abs(Math.cos(ry)), sin = Math.abs(Math.sin(ry));
      const effW = 1.3 * cos + 0.7 * sin, effD = 1.3 * sin + 0.7 * cos;
      colls.push({ furnId: f.id, x0: x - effW / 2, x1: x + effW / 2, z0: z - effD / 2, z1: z + effD / 2, top: y + 0.4 });
      inters.push({ furnId: f.id, x, z, label: 'Gunakan meja kopi' });
      break;
    }

    case 'beanbag_red':
    case 'beanbag_blue': {
      const color = f.type === 'beanbag_red' ? 0xc0392b : 0x2980b9;
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.46, 14, 10),
        new THREE.MeshStandardMaterial({ color, roughness: 0.95 }),
      );
      m.scale.set(1, 0.62, 1);
      m.position.y = 0.28; m.castShadow = true; g.add(m);
      colls.push({ furnId: f.id, x0: x - 0.46, x1: x + 0.46, z0: z - 0.46, z1: z + 0.46, top: y + 0.58 });
      inters.push({ furnId: f.id, x, z, label: 'Duduk di beanbag', action: 'seat', ry: 0, seatHeight: 0.12 });
      break;
    }

    case 'bookshelf': {
      const frame = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.8, 0.36), M.woodDark);
      frame.position.y = 0.9; frame.castShadow = true; g.add(frame);
      const bookColors = [0xc0392b, 0x2980b9, 0x27ae60, 0xf39c12, 0x8e44ad, 0x16a085];
      for (let s = 0; s < 3; s++) {
        const by = 0.42 + s * 0.5;
        const shelf = new THREE.Mesh(new THREE.BoxGeometry(1.64, 0.05, 0.3), M.wood);
        shelf.position.set(0, by - 0.02, 0.02); g.add(shelf);
        let bx = -0.72, bi = 0;
        while (bx < 0.68) {
          const bw = 0.07 + ((bi * 37 + s * 11) % 5) * 0.015;
          const bh = 0.3 + ((bi * 53 + s * 7) % 4) * 0.04;
          const book = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, 0.2),
            new THREE.MeshStandardMaterial({ color: bookColors[(bi + s) % bookColors.length], roughness: 0.85 }));
          book.position.set(bx + bw / 2, by + bh / 2, 0.02);
          g.add(book);
          bx += bw + 0.012; bi++;
        }
      }
      const cos = Math.abs(Math.cos(ry)), sin = Math.abs(Math.sin(ry));
      const effW = 1.8 * cos + 0.36 * sin, effD = 1.8 * sin + 0.36 * cos;
      colls.push({ furnId: f.id, x0: x - effW / 2, x1: x + effW / 2, z0: z - effD / 2, z1: z + effD / 2, top: y + 1.8 });
      inters.push({ furnId: f.id, x, z, label: 'Baca buku' });
      break;
    }

    case 'rug': {
      const rug = new THREE.Mesh(
        new THREE.BoxGeometry(3.8, 0.025, 2.8),
        new THREE.MeshStandardMaterial({ color: 0xd9cba6, roughness: 0.95 }),
      );
      rug.position.y = 0.013; rug.receiveShadow = true; g.add(rug);
      break;
    }

    case 'cabinet': {
      const w = opts.w || 1.8, h = opts.h || 1.2, d = opts.d || 0.5;
      const cab = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), M.woodDark);
      cab.position.y = h / 2; cab.castShadow = true; g.add(cab);
      const cos = Math.abs(Math.cos(ry)), sin = Math.abs(Math.sin(ry));
      const effW = w * cos + d * sin, effD = w * sin + d * cos;
      colls.push({ furnId: f.id, x0: x - effW / 2, x1: x + effW / 2, z0: z - effD / 2, z1: z + effD / 2, top: y + h });
      inters.push({ furnId: f.id, x, z, label: 'Buka lemari kabinet' });
      break;
    }

    case 'plant': {
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.18, 0.38, 12),
        new THREE.MeshStandardMaterial({ color: 0xa0714f, roughness: 0.8 }));
      pot.position.y = 0.19; pot.castShadow = true; g.add(pot);
      const fol = new THREE.Mesh(new THREE.IcosahedronGeometry(0.45, 1),
        new THREE.MeshStandardMaterial({ color: 0x2e7d4f, roughness: 0.9 }));
      fol.position.y = 0.82; fol.castShadow = true; g.add(fol);
      colls.push({ furnId: f.id, x0: x - 0.22, x1: x + 0.22, z0: z - 0.22, z1: z + 0.22, top: y + 1.27 });
      inters.push({ furnId: f.id, x, z, label: 'Periksa tanaman' });
      break;
    }

    case 'kitchen_counter': {
      const w = 3.8;
      const base = new THREE.Mesh(new THREE.BoxGeometry(w, 0.84, 0.62), M.cabinet);
      base.position.y = 0.42; base.castShadow = true; g.add(base);
      const top = new THREE.Mesh(new THREE.BoxGeometry(w + 0.08, 0.07, 0.7), M.counterTop);
      top.position.y = 0.875; top.castShadow = true; g.add(top);
      const sink = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.1, 0.42),
        new THREE.MeshStandardMaterial({ color: 0x9aa2a8, roughness: 0.35, metalness: 0.5 }));
      sink.position.set(-0.9, 0.9, 0); g.add(sink);
      const rack = new THREE.Mesh(new THREE.BoxGeometry(w * 0.7, 0.7, 0.32), M.wood);
      rack.position.set(0.3, 1.95, -0.12); g.add(rack);

      const cos = Math.abs(Math.cos(ry)), sin = Math.abs(Math.sin(ry));
      const effW = w * cos + 0.7 * sin, effD = w * sin + 0.7 * cos;
      colls.push({ furnId: f.id, x0: x - effW / 2, x1: x + effW / 2, z0: z - effD / 2, z1: z + effD / 2, top: y + 0.95 });
      inters.push({ furnId: f.id, x, z, label: 'Siapkan minuman di pantry' });
      break;
    }

    case 'fridge': {
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.9, 0.85), M.white);
      body.position.y = 0.95; body.castShadow = true; g.add(body);
      const handle = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.5, 0.06), new THREE.MeshStandardMaterial({ color: 0x9aa2a8 }));
      handle.position.set(-0.32, 1.15, 0.45); g.add(handle);
      const divider = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.04, 0.02), new THREE.MeshStandardMaterial({ color: 0xb9c2c9 }));
      divider.position.set(0, 1.25, 0.43); g.add(divider);

      const cos = Math.abs(Math.cos(ry)), sin = Math.abs(Math.sin(ry));
      const effW = 0.95 * cos + 0.85 * sin, effD = 0.95 * sin + 0.85 * cos;
      colls.push({ furnId: f.id, x0: x - effW / 2, x1: x + effW / 2, z0: z - effD / 2, z1: z + effD / 2, top: y + 1.9 });
      inters.push({ furnId: f.id, x, z, label: 'Buka kulkas' });
      break;
    }

    case 'dispenser': {
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.48, 1.05, 0.48), M.white);
      body.position.y = 0.525; body.castShadow = true; g.add(body);
      const gal = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.42, 12), M.bottleBlue);
      gal.position.set(0, 1.28, 0); gal.castShadow = true; g.add(gal);
      const tap = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.1, 0.06), new THREE.MeshStandardMaterial({ color: 0x2c3138 }));
      tap.position.set(0, 0.8, 0.25); g.add(tap);

      colls.push({ furnId: f.id, x0: x - 0.28, x1: x + 0.28, z0: z - 0.28, z1: z + 0.28, top: y + 1.5 });
      inters.push({ furnId: f.id, x, z, label: 'Ambil air minum' });
      break;
    }

    case 'printer': {
      const stand = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.85, 0.9), M.wood);
      stand.position.y = 0.425; stand.castShadow = true; g.add(stand);
      const prn = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.55, 0.75), new THREE.MeshStandardMaterial({ color: 0xdfe3e6 }));
      prn.position.set(0, 1.12, 0); prn.castShadow = true; g.add(prn);
      const tray = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.1, 0.5), new THREE.MeshStandardMaterial({ color: 0x9aa2a8 }));
      tray.position.set(0, 1.44, 0); g.add(tray);

      const cos = Math.abs(Math.cos(ry)), sin = Math.abs(Math.sin(ry));
      const effW = 1.7 * cos + 0.9 * sin, effD = 1.7 * sin + 0.9 * cos;
      colls.push({ furnId: f.id, x0: x - effW / 2, x1: x + effW / 2, z0: z - effD / 2, z1: z + effD / 2, top: y + 1.5 });
      inters.push({ furnId: f.id, x, z, label: 'Gunakan printer' });
      break;
    }

    case 'laptop': {
      const lapBase = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.03, 0.26), M.chairBlack);
      lapBase.position.y = 0.77; lapBase.castShadow = true; g.add(lapBase);
      const lapLid = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.25, 0.025), M.chairBlack);
      lapLid.position.set(0, 0.89, -0.115); lapLid.rotation.x = -0.3; g.add(lapLid);
      const lapScr = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.21), M.screen);
      lapScr.position.set(0, 0.895, -0.1); lapScr.rotation.x = -0.3; g.add(lapScr);
      break;
    }

    case 'tv': {
      const w = 1.6;
      const panel = new THREE.Mesh(new THREE.BoxGeometry(w, 0.9, 0.09), M.chairBlack);
      panel.castShadow = true; g.add(panel);
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.14, 0.76), M.tvScreen);
      scr.position.z = 0.048; g.add(scr);
      const brk = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.3, 0.14), M.metal);
      brk.position.z = -0.09; g.add(brk);
      g.position.y = 1.8;
      inters.push({ furnId: f.id, x, z, label: 'Nyalakan layar rapat' });
      break;
    }

    case 'ac': {
      const unit = new THREE.Mesh(
        new THREE.BoxGeometry(1.1, 0.32, 0.24),
        new THREE.MeshStandardMaterial({ color: 0xf2f4f4, roughness: 0.5 }),
      );
      unit.castShadow = true; g.add(unit);
      const vent = new THREE.Mesh(
        new THREE.BoxGeometry(0.9, 0.05, 0.03),
        new THREE.MeshStandardMaterial({ color: 0x3a3f45 }),
      );
      vent.position.set(0, -0.08, 0.12); g.add(vent);
      g.position.y = 2.45;
      break;
    }

    case 'clock': {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 256;
      const c = cv.getContext('2d');
      c.fillStyle = '#ffffff';
      c.beginPath(); c.arc(128, 128, 120, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#23262b'; c.lineWidth = 10;
      c.beginPath(); c.arc(128, 128, 112, 0, Math.PI * 2); c.stroke();
      for (let i = 0; i < 12; i++) {
        const a = (i * Math.PI) / 6;
        c.strokeStyle = '#23262b'; c.lineWidth = i % 3 === 0 ? 9 : 4;
        c.beginPath();
        c.moveTo(128 + Math.cos(a) * 94, 128 + Math.sin(a) * 94);
        c.lineTo(128 + Math.cos(a) * 104, 128 + Math.sin(a) * 104);
        c.stroke();
      }
      c.strokeStyle = '#23262b'; c.lineCap = 'round';
      c.lineWidth = 10;
      c.beginPath(); c.moveTo(128, 128);
      c.lineTo(128 + Math.cos(-1.05) * 55, 128 + Math.sin(-1.05) * 55); c.stroke();
      c.lineWidth = 7;
      c.beginPath(); c.moveTo(128, 128);
      c.lineTo(128 + Math.cos(-0.25) * 85, 128 + Math.sin(-0.25) * 85); c.stroke();
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      const rim = new THREE.Mesh(
        new THREE.CylinderGeometry(0.32, 0.32, 0.07, 24),
        new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.6 }),
      );
      rim.rotation.x = Math.PI / 2; g.add(rim);
      const face = new THREE.Mesh(
        new THREE.CircleGeometry(0.29, 24),
        new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 }),
      );
      face.position.z = 0.037; g.add(face);
      g.position.y = 2.25;
      break;
    }

    case 'toilet_bowl': {
      const bowl = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.4, 0.45), M.white);
      bowl.position.y = 0.2; bowl.castShadow = true; g.add(bowl);
      const tank = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.55, 0.48), M.white);
      tank.position.set(0.32, 0.68, 0); tank.castShadow = true; g.add(tank);
      colls.push({ furnId: f.id, x0: x - 0.28, x1: x + 0.42, z0: z - 0.24, z1: z + 0.24, top: y + 1.1 });
      inters.push({ furnId: f.id, x, z, label: 'Duduk di toilet', action: 'seat', ry: -Math.PI / 2, seatHeight: 0.2 });
      break;
    }

    case 'sink': {
      const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 0.58, 10), M.white);
      ped.position.y = 0.29; ped.castShadow = true; g.add(ped);
      const basin = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.2, 0.2, 14), M.white);
      basin.position.y = 0.66; basin.castShadow = true; g.add(basin);
      colls.push({ furnId: f.id, x0: x - 0.32, x1: x + 0.32, z0: z - 0.32, z1: z + 0.32, top: y + 0.76 });
      inters.push({ furnId: f.id, x, z, label: 'Gunakan wastafel' });
      break;
    }

    case 'prayer_mat': {
      const mat = new THREE.Mesh(
        new THREE.BoxGeometry(0.78, 0.035, 1.3),
        new THREE.MeshStandardMaterial({ color: 0xe6b489, roughness: 0.95 }),
      );
      mat.position.y = 0.018; mat.receiveShadow = true; g.add(mat);
      const trim = new THREE.Mesh(
        new THREE.BoxGeometry(0.86, 0.02, 1.38),
        new THREE.MeshStandardMaterial({ color: 0x8e2f32, roughness: 0.95 }),
      );
      trim.position.y = 0.008; trim.receiveShadow = true; g.add(trim);
      inters.push({ furnId: f.id, x, z, label: 'Berdoa' });
      break;
    }

    case 'mihrab': {
      const cv = document.createElement('canvas');
      cv.width = 256; cv.height = 256;
      const c = cv.getContext('2d');
      c.fillStyle = '#d8cba6'; c.fillRect(0, 0, 256, 256);
      c.fillStyle = '#c9a227';
      c.beginPath(); c.arc(128, 128, 68, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#d8cba6';
      c.beginPath(); c.arc(154, 108, 56, 0, Math.PI * 2); c.fill();
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      const bg = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.7, 0.08),
        new THREE.MeshStandardMaterial({ color: 0x8e2f32, roughness: 0.8 }));
      bg.position.set(0, 1.35, -0.03); g.add(bg);
      const face = new THREE.Mesh(
        new THREE.PlaneGeometry(1.45, 1.45),
        new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 }),
      );
      face.position.set(0, 1.35, 0.02); g.add(face);
      break;
    }

    case 'board': {
      // Papan Task Kanban
      const panel = new THREE.Mesh(
        new THREE.BoxGeometry(4.2, 2.2, 0.12),
        new THREE.MeshStandardMaterial({ color: 0x8a6d4b, roughness: 0.8 }),
      );
      panel.position.y = 1.7; panel.castShadow = true; g.add(panel);
      if (boardCanvas && boardTexture) {
        const face = new THREE.Mesh(
          new THREE.PlaneGeometry(4.0, 2.0),
          new THREE.MeshStandardMaterial({ map: boardTexture, roughness: 0.9 }),
        );
        face.position.set(0, 1.7, -0.07);
        face.rotation.y = Math.PI;
        g.add(face);
      }
      colls.push({ furnId: f.id, x0: x - 2.1, x1: x + 2.1, z0: z - 0.15, z1: z + 0.15, top: y + 2.8 });
      inters.push({ furnId: f.id, x, z: z - 0.65, label: 'Buka papan Kanban', action: 'board', ry: Math.PI });
      break;
    }

    default: {
      const cube = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), M.wood);
      cube.position.y = 0.4; cube.castShadow = true; g.add(cube);
      colls.push({ furnId: f.id, x0: x - 0.4, x1: x + 0.4, z0: z - 0.4, z1: z + 0.4, top: y + 0.8 });
      break;
    }
  }

  g.position.set(x, y, z);
  g.rotation.y = ry;
  tagFurnMesh(g, f.id);
  scene.add(g);

  return { item: f, group: g, colliders: colls, interactables: inters };
}

function removeFurnitureItem(id) {
  const existing = furnitureObjects.get(id);
  if (existing) {
    scene.remove(existing.group);
    furnitureObjects.delete(id);
  }
  dynamicColliders = dynamicColliders.filter((c) => c.furnId !== id);
  dynamicInteractables = dynamicInteractables.filter((i) => i.furnId !== id);
  if (selectedFurnId === id) {
    selectedFurnId = null;
    selectionRing.visible = false;
    updateEditorUI();
  }
}

function addOrUpdateFurnitureItem(f) {
  removeFurnitureItem(f.id);
  const obj = instantiateFurniture(f);
  furnitureObjects.set(f.id, obj);
  dynamicColliders.push(...obj.colliders);
  dynamicInteractables.push(...obj.interactables);
  if (selectedFurnId === f.id) {
    selectionRing.position.set(f.x, 0.035, f.z);
    selectionRing.visible = isEditMode;
    updateEditorUI();
  }
}

function renderAllFurniture(list) {
  for (const id of [...furnitureObjects.keys()]) {
    removeFurnitureItem(id);
  }
  furnitureList = list || [];
  for (const f of furnitureList) {
    if (f && f.id && f.type) {
      const obj = instantiateFurniture(f);
      furnitureObjects.set(f.id, obj);
      dynamicColliders.push(...obj.colliders);
      dynamicInteractables.push(...obj.interactables);
    }
  }
}

// ---------- Ruangan Dasar (Lantai & Dinding Statis) ----------
function buildFloor() {
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(34.6, 22.6),
    new THREE.MeshStandardMaterial({ map: tileTexture(), roughness: 0.55, metalness: 0.05 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
}

function buildWalls() {
  // dinding luar
  wallH(-17, 17, -11);
  wallH(-17, 17, 11);
  wallV(-11, 11, -17);
  wallV(-11, 11, 17);
  // pemisah lajur utara/selatan (z=-4); koridor terbuka di x -9..-7 dan 9..11
  wallH(-17, -9, -4);
  wallH(-7, 9, -4, [[-3, -1.9], [1.9, 3]]);
  // Relax Room membentang z -7..-2 di kolom timur
  wallV(-11, -4, -9, [[-7, -5.9]]);   // Multipurpose
  wallV(-4, 1, -9, [[-2, -0.9]]);     // Head Room 1
  wallV(1, 11, -9, [[5, 6.1]]);       // Head Room 2
  // dinding timur koridor barat (x=-7)
  wallV(-11, -4, -7, [[-7, -5.9]]);   // Meeting Room
  wallV(-4, 11, -7, [[-2, -0.9], [3, 4.1]]); // Office
  // dinding barat koridor timur (x=9)
  wallV(-11, -4, 9, [[-7, -5.9]]);    // Meeting Room
  wallV(-4, 11, 9, [[-2, -0.9], [3, 4.1]]);  // Office
  // dinding timur koridor timur (x=11)
  wallV(-11, -7, 11, [[-9.5, -8.4]]); // Pantry
  wallV(-7, -2, 11, [[-5, -3.9]]);    // Relax Room
  wallV(-2, 4, 11, [[0, 1.1]]);       // Boss Room
  wallV(4, 11, 11, [[5.8, 7.3]]);     // Toilet (pintu lebar 1.5m)
  // sekat horizontal kolom kanan & kiri
  wallH(11, 17, -7);  // Pantry | Relax
  wallH(11, 17, -2);  // Relax | Boss
  wallH(11, 17, 4);   // Boss | Toilet
  wallH(-17, -9, 1);  // Head 1 | Head 2

  // Partisi dalam toilet
  solidBox(2.2, 1.8, 0.08, M.white, 15.9, 0.9, 7.5);
  solidBox(0.08, 1.8, 0.8, M.white, 14.8, 0.9, 4.4);
  solidBox(0.08, 1.8, 0.8, M.white, 14.8, 0.9, 10.6);
  const mirror = new THREE.Mesh(
    new THREE.PlaneGeometry(2.4, 1.0),
    new THREE.MeshStandardMaterial({ color: 0xcfe8ef, roughness: 0.12, metalness: 0.55 }),
  );
  mirror.position.set(13.05, 1.7, 4.08);
  scene.add(mirror);
}

function buildPlates() {
  roomPlate('Multipurpose', -8.82, 2.35, -6.45, Math.PI / 2);
  roomPlate('Meeting Room', -7.18, 2.35, -6.45, -Math.PI / 2);
  roomPlate('Pantry', 10.82, 2.35, -8.95, -Math.PI / 2);
  roomPlate('Relax Room', 10.82, 2.35, -4.45, -Math.PI / 2);
  roomPlate('Boss Room', 10.82, 2.35, 0.55, -Math.PI / 2);
  roomPlate('Toilet', 10.82, 2.35, 6.55, -Math.PI / 2);
  roomPlate('Head Room 1', -8.82, 2.35, -1.45, Math.PI / 2);
  roomPlate('Head Room 2', -8.82, 2.35, 5.55, Math.PI / 2);
  roomPlate('Office', -7.18, 2.35, -1.45, -Math.PI / 2);
  roomPlate('Office', 9.18, 2.35, -1.45, Math.PI / 2);
}

function buildTubeLights() {
  buildTubeLight(-14, -9); buildTubeLight(-12, -6);
  buildTubeLight(-4, -9); buildTubeLight(0, -9); buildTubeLight(4, -9); buildTubeLight(0, -6);
  buildTubeLight(13, -9); buildTubeLight(15.5, -9);
  buildTubeLight(13, -4.5); buildTubeLight(15.5, -4.5);
  buildTubeLight(-13, -1.5);
  buildTubeLight(-13, 3.5); buildTubeLight(-13, 8);
  for (const [lx, lz] of [[-4, -1], [0, -1], [4, -1], [-4, 4], [4, 4], [0, 8]]) buildTubeLight(lx, lz);
  buildTubeLight(13.5, 0); buildTubeLight(15.5, 2.5);
  buildTubeLight(13, 6); buildTubeLight(15, 8.5);
  buildTubeLight(-8, -7); buildTubeLight(-8, 2); buildTubeLight(-8, 8);
  buildTubeLight(10, -7); buildTubeLight(10, 2); buildTubeLight(10, 8);
}

// ---------- papan task 3D ----------
let boardTexture, boardCanvas;
function initBoardCanvas() {
  boardCanvas = document.createElement('canvas');
  boardCanvas.width = 1024; boardCanvas.height = 512;
  boardTexture = new THREE.CanvasTexture(boardCanvas);
  boardTexture.colorSpace = THREE.SRGBColorSpace;
  updateBoardTexture();
}

function updateBoardTexture() {
  if (!boardCanvas) return;
  const c = boardCanvas.getContext('2d');
  const W = 1024, H = 512;
  c.fillStyle = '#fffdf6'; c.fillRect(0, 0, W, H);
  c.fillStyle = '#22303c'; c.font = 'bold 46px sans-serif'; c.textAlign = 'center';
  c.fillText('PAPAN TASK', W / 2, 62);
  const cols = [
    { label: 'ANTRI', color: '#e67e22', id: 'antri' },
    { label: 'DIKERJAKAN', color: '#2980b9', id: 'dikerjakan' },
    { label: 'SELESAI', color: '#27ae60', id: 'selesai' },
  ];
  const cw = W / 3;
  cols.forEach((col, i) => {
    const x0 = i * cw;
    c.fillStyle = col.color;
    c.fillRect(x0 + 18, 88, cw - 36, 58);
    c.fillStyle = '#fff'; c.font = 'bold 34px sans-serif';
    c.fillText(col.label, x0 + cw / 2, 128);
    const items = tasks.filter((t) => t.col === col.id);
    c.fillStyle = '#6b7a88'; c.font = '26px sans-serif';
    c.fillText(`${items.length} kartu`, x0 + cw / 2, 172);
    c.fillStyle = '#22303c'; c.font = '24px sans-serif'; c.textAlign = 'left';
    items.slice(0, 6).forEach((t, j) => {
      let title = t.title;
      if (title.length > 22) title = title.slice(0, 21) + '…';
      c.fillText('• ' + title, x0 + 34, 216 + j * 40);
    });
    c.textAlign = 'center';
  });
  if (boardTexture) boardTexture.needsUpdate = true;
}

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

function buildWorld() {
  buildFloor();
  buildWalls();
  buildPlates();
  buildTubeLights();
  initBoardCanvas();
  renderAllFurniture(defaultFurniture());
}

// ---------- avatar gaya LEGO ----------
function nameSprite(name, color) {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 72;
  const draw = (text, isSpeaking = false, micActive = false, vol = 0) => {
    const c = cv.getContext('2d');
    c.clearRect(0, 0, 256, 72);

    if (isSpeaking) {
      c.fillStyle = 'rgba(10, 42, 26, 0.92)';
      c.strokeStyle = '#2ecc71';
      c.lineWidth = 3;
    } else if (micActive) {
      c.fillStyle = 'rgba(18, 32, 42, 0.85)';
      c.strokeStyle = 'rgba(46, 204, 113, 0.5)';
      c.lineWidth = 1.5;
    } else {
      c.fillStyle = 'rgba(20, 28, 38, 0.78)';
      c.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      c.lineWidth = 1;
    }
    c.beginPath();
    c.roundRect(2, 6, 252, 60, 16);
    c.fill();
    c.stroke();

    c.fillStyle = color;
    c.beginPath();
    c.arc(32, 36, 14, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#ffffff';
    c.font = 'bold 15px system-ui, sans-serif';
    c.textAlign = 'center';
    c.fillText(text.slice(0, 1).toUpperCase(), 32, 41.5);

    c.font = '600 21px system-ui, sans-serif';
    c.textAlign = 'left';
    let label = text.length > 9 ? text.slice(0, 8) + '…' : text;
    c.fillStyle = isSpeaking ? '#a8ffc8' : '#ffffff';
    c.fillText(label, 54, 43.5);

    if (isSpeaking) {
      c.fillStyle = '#2ecc71';
      const bx = 202;
      const t = Date.now() / 120;
      const h1 = 8 + Math.sin(t) * 5 + Math.min(vol * 15, 6);
      const h2 = 16 + Math.cos(t * 1.3) * 7 + Math.min(vol * 20, 8);
      const h3 = 10 + Math.sin(t * 0.9 + 1) * 6 + Math.min(vol * 15, 6);
      const h4 = 6 + Math.cos(t * 1.5 + 2) * 4 + Math.min(vol * 10, 4);

      c.beginPath(); c.roundRect(bx, 36 - h1/2, 3.5, h1, 2); c.fill();
      c.beginPath(); c.roundRect(bx + 7, 36 - h2/2, 3.5, h2, 2); c.fill();
      c.beginPath(); c.roundRect(bx + 14, 36 - h3/2, 3.5, h3, 2); c.fill();
      c.beginPath(); c.roundRect(bx + 21, 36 - h4/2, 3.5, h4, 2); c.fill();
    } else if (micActive) {
      c.fillStyle = '#2ecc71';
      c.strokeStyle = '#2ecc71';
      c.lineWidth = 1.6;
      c.beginPath(); c.roundRect(218, 26, 6, 12, 3); c.fill();
      c.beginPath(); c.arc(221, 37, 5.5, 0, Math.PI); c.stroke();
      c.beginPath(); c.moveTo(221, 42.5); c.lineTo(221, 47); c.stroke();
      c.beginPath(); c.moveTo(217, 47); c.lineTo(225, 47); c.stroke();
    }
  };
  draw(name, false, false, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sp.scale.set(2.1, 0.59, 1);
  sp.position.y = 2.05;
  sp.userData.redraw = (nm = name, isSpeaking = false, micActive = false, vol = 0) => {
    draw(nm, isSpeaking, micActive, vol);
    tex.needsUpdate = true;
  };
  sp.userData.tex = tex;
  return sp;
}

function makeAvatar(colorHex, name) {
  const g = new THREE.Group();
  const legs = [];
  const torsoMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(colorHex), roughness: 0.55 });
  const yellowMat = new THREE.MeshStandardMaterial({ color: 0xf7c500, roughness: 0.55 });
  const legMat = new THREE.MeshStandardMaterial({ color: 0x2b3a4a, roughness: 0.7 });
  for (const s of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.72, 0.24), legMat);
    leg.position.set(s * 0.105, 0.36, 0);
    leg.castShadow = true;
    g.add(leg);
    legs.push(leg);
  }
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.55, 0.28), torsoMat);
  torso.position.y = 0.995;
  torso.castShadow = true;
  g.add(torso);
  for (const s of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.52, 0.17), torsoMat);
    arm.position.set(s * 0.315, 0.98, 0);
    arm.castShadow = true;
    g.add(arm);
    const hand = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.1, 10), yellowMat);
    hand.position.set(s * 0.315, 0.68, 0);
    g.add(hand);
  }
  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.24, 18), yellowMat);
  head.position.y = 1.39;
  head.castShadow = true;
  g.add(head);
  const stud = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.05, 12), yellowMat);
  stud.position.y = 1.535;
  g.add(stud);
  const tag = nameSprite(name, colorHex);
  g.add(tag);
  g.userData.legs = legs;
  g.userData.tag = tag;
  return g;
}

function setAvatarPose(group, sitting) {
  for (const leg of group.userData.legs || []) {
    leg.rotation.x = sitting ? -Math.PI / 2 : 0;
    leg.position.z = sitting ? 0.18 : 0;
  }
}

function addUser(u) {
  if (users.has(u.id)) return;
  const group = makeAvatar(u.color, u.name);
  group.position.set(u.x, u.y || 0, u.z);
  group.rotation.y = u.ry;
  setAvatarPose(group, u.sitting);
  scene.add(group);
  const tag = group.userData.tag;
  const micActive = Boolean(u.micActive);
  const speaking = Boolean(u.speaking);
  if (tag && tag.userData.redraw) tag.userData.redraw(u.name, speaking, micActive, 0);
  users.set(u.id, {
    data: u,
    group,
    tag,
    tx: u.x,
    ty: u.y || 0,
    tz: u.z,
    try_: u.ry,
    micActive,
    speaking,
    volume: 0,
  });
  renderUsers();
}

function removeUser(id) {
  const u = users.get(id);
  if (!u) return;
  closePeer(id);
  scene.remove(u.group);
  users.delete(id);
  renderUsers();
}

// ---------- jaringan & audio ----------
function send(obj) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj));
}

function addLocalTracks(peerId, state) {
  if (!localStream) return;
  for (const track of localStream.getAudioTracks()) {
    if (!state.pc.getSenders().some((sender) => sender.track?.id === track.id)) {
      state.pc.addTrack(track, localStream);
    }
  }
}

let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

function ensureAudioContext() {
  if (!audioContext) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioCtx();
  }
  if (audioContext.state === 'suspended') {
    audioContext.resume().catch(() => {});
  }
  return audioContext;
}
window.addEventListener('click', ensureAudioContext, { passive: true });
window.addEventListener('pointerdown', ensureAudioContext, { passive: true });
window.addEventListener('keydown', ensureAudioContext, { passive: true });
window.addEventListener('touchstart', ensureAudioContext, { passive: true });

function ensurePeer(peerId) {
  if (peerConnections.has(peerId)) return peerConnections.get(peerId);
  const pc = new RTCPeerConnection({ iceServers });
  const state = {
    pc,
    polite: String(myId).localeCompare(peerId) > 0,
    makingOffer: false,
    ignoreOffer: false,
    settingRemoteAnswer: false,
  };
  peerConnections.set(peerId, state);
  addLocalTracks(peerId, state);

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) send({ t: 'rtc_signal', to: peerId, signal: { candidate } });
  };

  pc.onnegotiationneeded = async () => {
    try {
      state.makingOffer = true;
      await pc.setLocalDescription();
      send({ t: 'rtc_signal', to: peerId, signal: { description: pc.localDescription } });
    } catch (error) {
      console.error('Negosiasi audio gagal:', error);
    } finally {
      state.makingOffer = false;
    }
  };

  pc.ontrack = ({ streams, track }) => {
    const stream = streams[0] || new MediaStream([track]);

    let audioEl = remoteAudioElements.get(peerId);
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      audioEl.muted = true;
      document.body.appendChild(audioEl);
      remoteAudioElements.set(peerId, audioEl);
    }
    audioEl.srcObject = stream;
    audioEl.play().catch(() => {});

    ensureAudioContext();

    if (remoteAudio.has(peerId)) {
      const old = remoteAudio.get(peerId);
      try {
        old.source.disconnect();
        old.analyser.disconnect();
        old.gain.disconnect();
        old.panner.disconnect();
      } catch {}
    }

    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.3;

    const gain = audioContext.createGain();
    gain.gain.value = 1.0;

    const panner = audioContext.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'none';

    source.connect(analyser);
    analyser.connect(gain);
    gain.connect(panner);
    panner.connect(audioContext.destination);

    remoteAudio.set(peerId, {
      source,
      analyser,
      gain,
      panner,
      stream,
      freqData: new Uint8Array(analyser.frequencyBinCount),
    });
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      toast('Audio tidak tersambung. Periksa server TURN.');
    }
  };

  return state;
}

function closePeer(peerId) {
  const audio = remoteAudio.get(peerId);
  if (audio) {
    try {
      audio.source.disconnect();
      audio.analyser.disconnect();
      audio.gain.disconnect();
      audio.panner.disconnect();
    } catch {}
    remoteAudio.delete(peerId);
  }
  const audioEl = remoteAudioElements.get(peerId);
  if (audioEl) {
    try {
      audioEl.pause();
      audioEl.srcObject = null;
      audioEl.remove();
    } catch {}
    remoteAudioElements.delete(peerId);
  }
  const state = peerConnections.get(peerId);
  if (state) {
    state.pc.close();
    peerConnections.delete(peerId);
  }
}

function closeAllPeers() {
  for (const peerId of [...peerConnections.keys()]) closePeer(peerId);
}

async function receiveRtcSignal(message) {
  const state = ensurePeer(message.from);
  const { pc } = state;
  try {
    if (message.signal.description) {
      const description = message.signal.description;
      const readyForOffer = !state.makingOffer && (pc.signalingState === 'stable' || state.settingRemoteAnswer);
      const offerCollision = description.type === 'offer' && !readyForOffer;
      state.ignoreOffer = !state.polite && offerCollision;
      if (state.ignoreOffer) return;
      state.settingRemoteAnswer = description.type === 'answer';
      await pc.setRemoteDescription(description);
      state.settingRemoteAnswer = false;
      if (description.type === 'offer') {
        addLocalTracks(message.from, state);
        await pc.setLocalDescription();
        send({ t: 'rtc_signal', to: message.from, signal: { description: pc.localDescription } });
      }
    } else if (message.signal.candidate && !state.ignoreOffer) {
      try {
        await pc.addIceCandidate(message.signal.candidate);
      } catch (err) {
        if (!state.ignoreOffer) console.warn('Gagal menambah ICE candidate:', err);
      }
    }
  } catch (error) {
    if (!state.ignoreOffer) console.error('Signaling audio gagal:', error);
  }
}

async function toggleVoice() {
  if (!joined) { toast('Masuk ke kantor sebelum mengaktifkan mikrofon.'); return; }
  if (voiceDisabled && !isAdmin) {
    toast('Voice/audio dinonaktifkan oleh admin.');
    return;
  }
  
  if (localStream) {
    const track = localStream.getAudioTracks()[0];
    const enabled = !track?.enabled;
    if (track) track.enabled = enabled;
    
    voiceBtn.textContent = enabled ? 'Matikan mikrofon' : 'Aktifkan mikrofon';
    voiceBtn.setAttribute('aria-pressed', String(enabled));
    
    send({ t: 'voice_status', active: enabled, speaking: false });
    updateUserVoiceUI(myId, { micActive: enabled, speaking: false, volume: 0 });
    return;
  }

  try {
    ensureAudioContext();
    await audioContext.resume();
    
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    localSource = audioContext.createMediaStreamSource(localStream);
    localAnalyser = audioContext.createAnalyser();
    localAnalyser.fftSize = 256;
    localAnalyser.smoothingTimeConstant = 0.3;
    localFreqData = new Uint8Array(localAnalyser.frequencyBinCount);
    localSource.connect(localAnalyser);

    for (const peerId of users.keys()) {
      if (peerId !== myId) addLocalTracks(peerId, ensurePeer(peerId));
    }

    voiceBtn.textContent = 'Matikan mikrofon';
    voiceBtn.setAttribute('aria-pressed', 'true');
    
    send({ t: 'voice_status', active: true, speaking: false });
    updateUserVoiceUI(myId, { micActive: true, speaking: false, volume: 0 });
    toast('Mikrofon aktif.');
  } catch (error) {
    console.error('getUserMedia error:', error);
    toast(error.name === 'NotAllowedError' ? 'Izin mikrofon ditolak.' : 'Mikrofon tidak dapat diakses.');
  }
}

function updateSpatialAudio() {
  if (!audioContext || audioContext.state !== 'running') return;
  const listener = audioContext.listener;

  if (listener.positionX) {
    listener.positionX.setTargetAtTime(player.x, audioContext.currentTime, 0.05);
    listener.positionY.setTargetAtTime(player.y || 0, audioContext.currentTime, 0.05);
    listener.positionZ.setTargetAtTime(player.z, audioContext.currentTime, 0.05);
  } else if (listener.setPosition) {
    listener.setPosition(player.x, player.y || 0, player.z);
  }

  const fx = -Math.sin(player.ry);
  const fz = -Math.cos(player.ry);
  if (listener.forwardX) {
    listener.forwardX.setTargetAtTime(fx, audioContext.currentTime, 0.05);
    listener.forwardY.setTargetAtTime(0, audioContext.currentTime, 0.05);
    listener.forwardZ.setTargetAtTime(fz, audioContext.currentTime, 0.05);
    listener.upX.setTargetAtTime(0, audioContext.currentTime, 0.05);
    listener.upY.setTargetAtTime(1, audioContext.currentTime, 0.05);
    listener.upZ.setTargetAtTime(0, audioContext.currentTime, 0.05);
  } else if (listener.setOrientation) {
    listener.setOrientation(fx, 0, fz, 0, 1, 0);
  }

  const VOICE_FULL_RADIUS = 3.5;
  const VOICE_MAX_DISTANCE = 28;

  for (const [peerId, nodes] of remoteAudio) {
    const peer = users.get(peerId);
    if (!peer) continue;
    const px = peer.group.position.x, py = peer.group.position.y || 0, pz = peer.group.position.z;
    const dist = Math.hypot(px - player.x, pz - player.z);

    let targetGain = 0;
    if (dist <= VOICE_FULL_RADIUS) {
      targetGain = 1.0;
    } else if (dist < VOICE_MAX_DISTANCE) {
      const t = (dist - VOICE_FULL_RADIUS) / (VOICE_MAX_DISTANCE - VOICE_FULL_RADIUS);
      targetGain = (1 - t) * (1 - t) * 0.95 + 0.05;
    } else {
      targetGain = 0;
    }

    nodes.gain.gain.setTargetAtTime(targetGain, audioContext.currentTime, 0.08);

    if (nodes.panner.positionX) {
      nodes.panner.positionX.setTargetAtTime(px, audioContext.currentTime, 0.05);
      nodes.panner.positionY.setTargetAtTime(py, audioContext.currentTime, 0.05);
      nodes.panner.positionZ.setTargetAtTime(pz, audioContext.currentTime, 0.05);
    } else if (nodes.panner.setPosition) {
      nodes.panner.setPosition(px, py, pz);
    }

    if (nodes.analyser && nodes.freqData) {
      nodes.analyser.getByteFrequencyData(nodes.freqData);
      let sum = 0;
      for (let i = 0; i < nodes.freqData.length; i++) sum += nodes.freqData[i];
      const avg = sum / nodes.freqData.length;
      const isSpeaking = avg > 10;
      const vol = avg / 255;
      if (isSpeaking !== peer.speaking || (isSpeaking && Math.abs(vol - (peer.volume || 0)) > 0.1)) {
        peer.speaking = isSpeaking;
        peer.volume = vol;
        updateUserVoiceUI(peerId, { micActive: peer.micActive !== false, speaking: isSpeaking, volume: vol });
      }
    }
  }
}

function connect() {
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${wsProto}://${location.host}`);
  socket.onopen = () => {
    let savedAdminKey = '';
    try { savedAdminKey = localStorage.getItem('vo_admin_key') || ''; } catch { /* abaikan */ }
    send({ t: 'join', name: myName, undangan: myInvite, adminCode: savedAdminKey || undefined });
  };
  socket.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleServer(msg);
  };
  socket.onclose = () => {
    if (!wantOnline) return;
    if (joined) toast('Koneksi terputus.');
    closeAllPeers();
    joined = false;
    reconnectOverlay.classList.remove('hidden');
    // Coba terus dengan jeda makin panjang (maks 15 detik) sampai server kembali.
    setTimeout(() => {
      if (joined) return;
      connect();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 15000);
  };
}

function handleServer(m) {
  switch (m.t) {
    case 'init': {
      myId = m.you.id;
      if (m.isAdmin) {
        isAdmin = true;
      }
      if (Array.isArray(m.iceServers)) iceServers = m.iceServers;
      roomLocked = Boolean(m.roomLocked);
      voiceDisabled = Boolean(m.voiceDisabled);
      for (const id of [...users.keys()]) removeUser(id);
      for (const u of m.users) addUser(u);
      const me = users.get(myId);
      if (me) {
        myColor = me.data.color;
        player.x = me.data.x; player.y = me.data.y || 0; player.z = me.data.z; player.ry = me.data.ry;
        me.group.position.set(player.x, player.y, player.z);
        snapCamera();
      }
      tasks = m.tasks || [];
      renderKanban();
      if (m.furniture) {
        renderAllFurniture(m.furniture);
      }
      updateBoardTexture();
      renderUsers();
      updateAdminPanel();
      joined = true;
      if (localStream) {
        for (const peerId of users.keys()) if (peerId !== myId) addLocalTracks(peerId, ensurePeer(peerId));
      }
      joinOverlay.classList.add('hidden');
      retryDelay = 1000;
      reconnectOverlay.classList.add('hidden');
      toast('Selamat datang di kantor virtual.');
      break;
    }
    case 'admin_auth_result': {
      if (adminLoginBtn._authTimeout) clearTimeout(adminLoginBtn._authTimeout);
      adminLoginBtn.disabled = false;
      adminLoginBtn.textContent = 'Buka Mode Edit';
      if (m.success || m.ok || m.isAdmin) {
        isAdmin = true;
        isEditMode = true;
        editorBar.classList.remove('hidden');
        editBtn.textContent = '🛠️ Keluar Edit';
        adminModal.classList.add('hidden');
        renderUsers();
        updateAdminPanel();
        toast('Akses Admin berhasil! Mode Edit aktif.');
      } else {
        toast('Kata sandi admin tidak sesuai.');
        adminKeyInput.focus();
        adminKeyInput.select();
      }
      break;
    }
    case 'kicked': {
      closeAllPeers();
      joined = false;
      wantOnline = false;
      if (socket) {
        socket.onclose = null; // Hentikan auto-reconnect
        socket.close();
      }
      reconnectOverlay.querySelector('.card p').textContent = m.reason || 'Anda telah dikeluarkan dari kantor oleh admin.';
      reconnectOverlay.classList.remove('hidden');
      toast('Anda telah dikeluarkan dari kantor oleh admin.');
      break;
    }
    case 'furniture_list': {
      renderAllFurniture(m.furniture);
      break;
    }
    case 'furniture_add': {
      addOrUpdateFurnitureItem(m.item);
      toast(`Furnitur ditambahkan: ${getFurnitureName(m.item.type)}`);
      break;
    }
    case 'furniture_update': {
      addOrUpdateFurnitureItem(m.item);
      if (selectedFurnId === m.item.id) {
        selectionRing.position.set(m.item.x, 0.035, m.item.z);
      }
      break;
    }
    case 'furniture_delete': {
      removeFurnitureItem(m.id);
      break;
    }
    case 'furniture_reset': {
      renderAllFurniture(m.furniture);
      toast('Tata letak furnitur telah direset ke default.');
      break;
    }
    case 'user_join':
      addUser(m.user);
      if (localStream) addLocalTracks(m.user.id, ensurePeer(m.user.id));
      toast(`${m.user.name} bergabung.`);
      break;
    case 'user_leave': {
      const u = users.get(m.id);
      if (u) toast(`${u.data.name} keluar.`);
      removeUser(m.id);
      break;
    }
    case 'user_move': {
      const u = users.get(m.id);
      if (u) {
        u.tx = m.x; u.ty = m.y || 0; u.tz = m.z; u.try_ = m.ry;
        u.data.sitting = m.sitting;
        setAvatarPose(u.group, m.sitting);
      }
      break;
    }
    case 'voice_status': {
      const u = users.get(m.id);
      if (u) {
        u.micActive = Boolean(m.active);
        u.speaking = Boolean(m.speaking);
        updateUserVoiceUI(m.id, { micActive: u.micActive, speaking: u.speaking });
      }
      break;
    }
    case 'chat':
      addChat(m.name, m.text, m.ts, (users.get(m.id) || {}).data?.color);
      break;
    case 'tasks':
      tasks = m.tasks || [];
      renderKanban(); updateBoardTexture();
      break;
    case 'rtc_signal':
      void receiveRtcSignal(m);
      break;
    case 'mute_all': {
      // Admin mematikan mikrofon semua orang
      if (localStream && myId) {
        const track = localStream.getAudioTracks()[0];
        if (track) track.enabled = false;
        voiceBtn.textContent = 'Aktifkan mikrofon';
        voiceBtn.setAttribute('aria-pressed', 'false');
        send({ t: 'voice_status', active: false, speaking: false });
        updateUserVoiceUI(myId, { micActive: false, speaking: false, volume: 0 });
      }
      toast(`🔇 ${m.by || 'Admin'} mematikan mikrofon semua peserta.`);
      break;
    }
    case 'room_lock': {
      roomLocked = Boolean(m.locked);
      updateAdminPanel();
      toast(roomLocked ? `🔒 Ruangan dikunci oleh ${m.by || 'Admin'}.` : `🔓 Ruangan dibuka oleh ${m.by || 'Admin'}.`);
      break;
    }
    case 'voice_disabled': {
      voiceDisabled = Boolean(m.disabled);
      updateAdminPanel();
      if (voiceDisabled && localStream && !isAdmin) {
        const track = localStream.getAudioTracks()[0];
        if (track) track.enabled = false;
        voiceBtn.textContent = 'Voice dinonaktifkan';
        voiceBtn.setAttribute('aria-pressed', 'false');
        send({ t: 'voice_status', active: false, speaking: false });
        updateUserVoiceUI(myId, { micActive: false, speaking: false, volume: 0 });
      }
      if (voiceDisabled) {
        voiceBtn.disabled = !isAdmin;
        toast(`🚫 Voice/audio dinonaktifkan oleh ${m.by || 'Admin'}.`);
      } else {
        voiceBtn.disabled = false;
        toast(`🔊 Voice/audio diaktifkan kembali oleh ${m.by || 'Admin'}.`);
      }
      break;
    }
    default:
      break;
  }
}

// ---------- UI & Obrolan ----------
const MIC_ON_SVG = '<svg class="mic-svg" viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>';
const MIC_OFF_SVG = '<svg class="mic-svg" viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c1.39-.2 2.66-.78 3.7-1.61L19.73 19 21 17.73 4.27 3z"/></svg>';
const SPEAKING_HTML = '<span class="voice-bars"><span class="vbar"></span><span class="vbar"></span><span class="vbar"></span></span>';

function updateUserVoiceUI(id, { micActive = false, speaking = false, volume = 0 } = {}) {
  const u = users.get(id);
  if (!u) return;
  u.micActive = micActive;
  u.speaking = speaking;
  u.volume = volume;

  if (u.tag && u.tag.userData.redraw) {
    u.tag.userData.redraw(u.data.name, speaking, micActive, volume);
  }

  const row = userList.querySelector(`[data-user-id="${id}"]`);
  if (row) {
    row.classList.toggle('speaking', speaking);
    const badge = row.querySelector('.voice-badge');
    if (badge) {
      if (speaking) {
        badge.className = 'voice-badge speaking';
        badge.title = 'Sedang berbicara';
        badge.innerHTML = SPEAKING_HTML;
      } else if (micActive) {
        badge.className = 'voice-badge active';
        badge.title = 'Mikrofon aktif';
        badge.innerHTML = MIC_ON_SVG;
      } else {
        badge.className = 'voice-badge muted';
        badge.title = 'Mikrofon nonaktif';
        badge.innerHTML = MIC_OFF_SVG;
      }
    }
  }
}

function renderUsers() {
  const list = [...users.values()].sort((a, b) => a.data.name.localeCompare(b.data.name));
  userCount.textContent = list.length;
  userList.innerHTML = '';
  for (const u of list) {
    const li = document.createElement('li');
    li.setAttribute('data-user-id', u.data.id);
    if (u.speaking) li.classList.add('speaking');

    const dot = document.createElement('span');
    dot.className = 'avatar-dot';
    dot.style.background = u.data.color;
    dot.textContent = u.data.name.slice(0, 1).toUpperCase();

    const nm = document.createElement('span');
    nm.className = 'name';
    nm.textContent = u.data.name + (u.data.id === myId ? ' (kamu)' : '');

    const badge = document.createElement('span');
    if (u.speaking) {
      badge.className = 'voice-badge speaking';
      badge.title = 'Sedang berbicara';
      badge.innerHTML = SPEAKING_HTML;
    } else if (u.micActive) {
      badge.className = 'voice-badge active';
      badge.title = 'Mikrofon aktif';
      badge.innerHTML = MIC_ON_SVG;
    } else {
      badge.className = 'voice-badge muted';
      badge.title = 'Mikrofon nonaktif';
      badge.innerHTML = MIC_OFF_SVG;
    }

    const on = document.createElement('span');
    on.className = 'online-dot';

    li.append(dot, nm, badge, on);

    if (isAdmin && u.data.id !== myId) {
      const kickBtn = document.createElement('button');
      kickBtn.type = 'button';
      kickBtn.className = 'kick-user-btn';
      kickBtn.title = `Keluarkan ${u.data.name} dari kantor`;
      kickBtn.textContent = '🚫';
      kickBtn.onclick = (e) => {
        e.stopPropagation();
        if (confirm(`Keluarkan ${u.data.name} dari kantor virtual?`)) {
          send({ t: 'kick', id: u.data.id });
        }
      };
      li.appendChild(kickBtn);
    }

    userList.appendChild(li);
  }
}

function addChat(name, text, ts, color) {
  const li = document.createElement('li');
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = name;
  if (color) who.style.color = color;
  const time = document.createElement('span');
  time.className = 'ts';
  time.textContent = new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  const body = document.createElement('div');
  body.textContent = text;
  li.append(who, time, body);
  chatList.appendChild(li);
  chatList.scrollTop = chatList.scrollHeight;
}

function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !joined) return;
  if (text.startsWith('/admin')) {
    const parts = text.split(/\s+/);
    const key = parts[1] || '';
    if (!key) { toast('Ketik: /admin <kode admin>'); chatInput.value = ''; return; }
    localStorage.setItem('vo_admin_key', key);
    send({ t: 'admin_auth', key, code: key, password: key, adminCode: key });
    chatInput.value = '';
    toast('Memverifikasi status admin...');
    return;
  }
  send({ t: 'chat', text });
  chatInput.value = '';
}

function toast(text) {
  const d = document.createElement('div');
  d.className = 'toast';
  d.textContent = text;
  toasts.appendChild(d);
  setTimeout(() => d.remove(), 3500);
}

function renderKanban() {
  kanbanCols.innerHTML = '';
  for (const col of TASK_COLS) {
    const box = document.createElement('div');
    box.className = 'kcol';
    const h = document.createElement('h3');
    h.textContent = col.label;
    box.appendChild(h);
    const items = tasks.filter((t) => t.col === col.id);
    if (!items.length) {
      const e = document.createElement('div');
      e.className = 'kempty';
      e.textContent = 'Belum ada kartu.';
      box.appendChild(e);
    }
    for (const t of items) {
      const card = document.createElement('div');
      card.className = 'kcard';
      const p = document.createElement('p');
      p.textContent = t.title;
      const ops = document.createElement('div');
      ops.className = 'ops';
      const idx = TASK_COLS.findIndex((c) => c.id === col.id);
      if (idx > 0) {
        const b = document.createElement('button');
        b.textContent = '← Pindah';
        b.onclick = () => send({ t: 'task_move', id: t.id, col: TASK_COLS[idx - 1].id });
        ops.appendChild(b);
      }
      if (idx < TASK_COLS.length - 1) {
        const b = document.createElement('button');
        b.textContent = 'Pindah →';
        b.onclick = () => send({ t: 'task_move', id: t.id, col: TASK_COLS[idx + 1].id });
        ops.appendChild(b);
      }
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = 'Hapus';
      del.onclick = () => send({ t: 'task_del', id: t.id });
      ops.appendChild(del);
      card.append(p, ops);
      box.appendChild(card);
    }
    const add = document.createElement('div');
    add.className = 'kadd';
    const inp = document.createElement('input');
    inp.placeholder = 'Kartu baru...';
    inp.maxLength = 120;
    const btn = document.createElement('button');
    btn.textContent = 'Tambah';
    const submit = () => {
      const title = inp.value.trim();
      if (!title) return;
      send({ t: 'task_add', title, col: col.id });
      inp.value = '';
    };
    btn.onclick = submit;
    inp.onkeydown = (e) => { if (e.key === 'Enter') submit(); e.stopPropagation(); };
    add.append(inp, btn);
    box.appendChild(add);
    kanbanCols.appendChild(box);
  }
}

// ============================================================================
// MODE EDIT & KATALOG
// ============================================================================
// ============================================================================
// ADMIN CONTROL PANEL (Mute All, Kick All, Lock Room, Disable Voice)
// ============================================================================

function updateAdminPanel() {
  const panel = $('adminControlPanel');
  // Toggle body class for CSS visibility of admin button
  document.body.classList.toggle('is-admin', isAdmin && joined);
  if (!panel) return;
  if (isAdmin && joined) {
    // Don't auto-show, let user toggle
  } else {
    panel.classList.add('hidden');
    return;
  }
  const lockBtn = $('lockRoomBtn');
  const disableVoiceBtn = $('disableVoiceBtn');
  if (lockBtn) {
    lockBtn.textContent = roomLocked ? '🔓 Buka Ruangan' : '🔒 Kunci Ruangan';
    lockBtn.classList.toggle('btn-active', roomLocked);
  }
  if (disableVoiceBtn) {
    disableVoiceBtn.textContent = voiceDisabled ? '🔊 Aktifkan Voice' : '🚫 Nonaktifkan Voice';
    disableVoiceBtn.classList.toggle('btn-active', voiceDisabled);
  }
}

// Admin panel toggle button
document.addEventListener('click', (e) => {
  if (e.target.id === 'adminPanelToggle' || e.target.closest('#adminPanelToggle')) {
    if (!isAdmin) { toast('Hanya admin yang bisa mengakses panel ini.'); return; }
    const panel = $('adminControlPanel');
    if (panel) {
      panel.classList.toggle('hidden');
      updateAdminPanel();
    }
  }
});

// Wire up admin control buttons
document.addEventListener('click', (e) => {
  if (e.target.id === 'muteAllBtn') {
    if (!isAdmin) return;
    if (confirm('Matikan mikrofon semua peserta?')) {
      send({ t: 'mute_all' });
    }
  }
  if (e.target.id === 'kickAllBtn') {
    if (!isAdmin) return;
    if (confirm('Keluarkan SEMUA peserta dari kantor? (Hanya admin yang tetap tinggal)')) {
      send({ t: 'kick_all' });
    }
  }
  if (e.target.id === 'lockRoomBtn') {
    if (!isAdmin) return;
    send({ t: 'lock_room', locked: !roomLocked });
  }
  if (e.target.id === 'disableVoiceBtn') {
    if (!isAdmin) return;
    send({ t: 'disable_voice', disabled: !voiceDisabled });
  }
  if (e.target.id === 'closeAdminPanelBtn') {
    const panel = $('adminControlPanel');
    if (panel) panel.classList.add('hidden');
  }
});

function updateEditorUI() {
  if (!isEditMode) {
    editorBar.classList.add('hidden');
    selectionRing.visible = false;
    editBtn.textContent = '🛠️ Mode Edit';
    return;
  }
  editorBar.classList.remove('hidden');
  editBtn.textContent = '🛠️ Keluar Edit';

  if (selectedFurnId && furnitureObjects.has(selectedFurnId)) {
    const item = furnitureObjects.get(selectedFurnId).item;
    selectedItemLabel.textContent = `Terpilih: ${getFurnitureName(item.type)} (x: ${item.x.toFixed(2)}, z: ${item.z.toFixed(2)})`;
    rotateFurnBtn.disabled = false;
    dupFurnBtn.disabled = false;
    delFurnBtn.disabled = false;
    selectionRing.position.set(item.x, 0.035, item.z);
    selectionRing.visible = true;
  } else {
    selectedItemLabel.textContent = 'Pilih furnitur di ruangan untuk menggeser';
    rotateFurnBtn.disabled = true;
    dupFurnBtn.disabled = true;
    delFurnBtn.disabled = true;
    selectionRing.visible = false;
  }
}

function populateCatalog() {
  catalogList.innerHTML = '';
  const categories = [...new Set(FURNITURE_CATALOG.map((c) => c.category))];
  
  for (const cat of categories) {
    const section = document.createElement('div');
    section.className = 'catalog-section';
    const title = document.createElement('h3');
    title.textContent = cat;
    section.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'catalog-grid';

    const items = FURNITURE_CATALOG.filter((c) => c.category === cat);
    for (const item of items) {
      const card = document.createElement('div');
      card.className = 'catalog-card';
      card.innerHTML = `
        <div class="catalog-icon">${item.icon}</div>
        <div class="catalog-title">${item.name}</div>
        <div class="catalog-desc">${item.desc}</div>
      `;
      card.onclick = () => {
        spawnNewFurniture(item.type);
        catalogModal.classList.add('hidden');
      };
      grid.appendChild(card);
    }
    section.appendChild(grid);
    catalogList.appendChild(section);
  }
}

function spawnNewFurniture(type) {
  // Letakkan 1.5m di depan pemain
  let sx = player.x + Math.sin(player.ry) * 1.5;
  let sz = player.z + Math.cos(player.ry) * 1.5;
  sx = Math.max(-16, Math.min(16, Math.round(sx * 4) / 4));
  sz = Math.max(-10, Math.min(10, Math.round(sz * 4) / 4));

  const newId = `f_${type}_${Date.now().toString(36)}`;
  const newItem = {
    id: newId,
    type,
    x: sx,
    y: 0,
    z: sz,
    ry: player.ry,
  };

  send({ t: 'furniture_add', item: newItem });
  selectedFurnId = newId;
  updateEditorUI();
}

function rotateSelectedFurniture() {
  if (!selectedFurnId || !furnitureObjects.has(selectedFurnId)) return;
  const obj = furnitureObjects.get(selectedFurnId);
  const curRy = Number(obj.item.ry) || 0;
  const newRy = (curRy + Math.PI / 4) % (Math.PI * 2);
  const updated = { ...obj.item, ry: +newRy.toFixed(3) };
  send({ t: 'furniture_update', item: updated });
  addOrUpdateFurnitureItem(updated);
  updateEditorUI();
}

function duplicateSelectedFurniture() {
  if (!selectedFurnId || !furnitureObjects.has(selectedFurnId)) return;
  const obj = furnitureObjects.get(selectedFurnId);
  const newId = `f_${obj.item.type}_${Date.now().toString(36)}`;
  const newItem = {
    ...obj.item,
    id: newId,
    x: Math.max(-16, Math.min(16, +(obj.item.x + 0.6).toFixed(2))),
    z: Math.max(-10, Math.min(10, +(obj.item.z + 0.6).toFixed(2))),
  };
  send({ t: 'furniture_add', item: newItem });
  selectedFurnId = newId;
  updateEditorUI();
}

function deleteSelectedFurniture() {
  if (!selectedFurnId) return;
  const idToDelete = selectedFurnId;
  selectedFurnId = null;
  send({ t: 'furniture_delete', id: idToDelete });
  removeFurnitureItem(idToDelete);
  updateEditorUI();
}

// Raycasting Furnitur
function getRaycastFurniture(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  mouseVec.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouseVec.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouseVec, camera);

  const meshes = [];
  for (const obj of furnitureObjects.values()) {
    obj.group.traverse((child) => {
      if (child.isMesh && child.userData.furnitureId) meshes.push(child);
    });
  }

  const intersects = raycaster.intersectObjects(meshes, false);
  if (intersects.length > 0) {
    const hitMesh = intersects[0].object;
    return hitMesh.userData.furnitureId;
  }
  return null;
}

// Handler Tombol UI Mode Edit
editBtn.onclick = () => {
  if (!joined) { toast('Masuk ke kantor terlebih dahulu.'); return; }
  if (isEditMode) {
    isEditMode = false;
    updateEditorUI();
    toast('Mode Edit dinonaktifkan.');
    return;
  }
  if (isAdmin) {
    isEditMode = true;
    updateEditorUI();
    toast('Mode Edit aktif.');
  } else {
    adminKeyInput.value = '';
    adminModal.classList.remove('hidden');
    setTimeout(() => adminKeyInput.focus(), 50);
  }
};

adminLoginBtn.onclick = () => {
  const key = adminKeyInput.value.trim();
  if (!key) {
    toast('Silakan masukkan kata sandi admin.');
    adminKeyInput.focus();
    return;
  }
  adminLoginBtn.disabled = true;
  adminLoginBtn.textContent = 'Memeriksa...';
  localStorage.setItem('vo_admin_key', key);

  if (adminLoginBtn._authTimeout) clearTimeout(adminLoginBtn._authTimeout);
  adminLoginBtn._authTimeout = setTimeout(() => {
    if (adminLoginBtn.disabled) {
      adminLoginBtn.disabled = false;
      adminLoginBtn.textContent = 'Buka Mode Edit';
      toast('Waktu verifikasi habis. Silakan coba lagi.');
    }
  }, 4000);

  send({ t: 'admin_auth', key, code: key, password: key, adminCode: key });
};

adminKeyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    adminLoginBtn.click();
  }
});

adminCloseBtn.onclick = () => adminModal.classList.add('hidden');
adminModal.onclick = (e) => { if (e.target === adminModal) adminModal.classList.add('hidden'); };

addFurnBtn.onclick = () => {
  populateCatalog();
  catalogModal.classList.remove('hidden');
};
catalogCloseBtn.onclick = () => catalogModal.classList.add('hidden');
catalogModal.onclick = (e) => { if (e.target === catalogModal) catalogModal.classList.add('hidden'); };

rotateFurnBtn.onclick = rotateSelectedFurniture;
dupFurnBtn.onclick = duplicateSelectedFurniture;
delFurnBtn.onclick = deleteSelectedFurniture;

resetFurnBtn.onclick = () => {
  if (confirm('Kembalikan semua tata letak furnitur kantor ke default awal?')) {
    send({ t: 'furniture_reset' });
  }
};

closeEditBtn.onclick = () => {
  isEditMode = false;
  selectedFurnId = null;
  updateEditorUI();
  toast('Mode Edit selesai.');
};

// ---------- input keyboard & mouse ----------
window.addEventListener('keydown', (e) => {
  const tag = document.activeElement ? document.activeElement.tagName : '';
  const typing = tag === 'INPUT' || tag === 'TEXTAREA';

  if (e.key === 'Enter') {
    if (document.activeElement === adminKeyInput) {
      e.preventDefault();
      adminLoginBtn.click();
      return;
    }
    if (document.activeElement === nameInput) {
      e.preventDefault();
      joinBtn.click();
      return;
    }
    if (document.activeElement === chatInput) {
      e.preventDefault();
      sendChat();
      return;
    }
    if (!typing && joined && kanbanModal.classList.contains('hidden') && joinOverlay.classList.contains('hidden') && adminModal.classList.contains('hidden') && catalogModal.classList.contains('hidden')) {
      e.preventDefault();
      chatInput.focus();
    }
    return;
  }
  if (e.key === 'Escape') {
    if (document.activeElement === chatInput) chatInput.blur();
    else {
      kanbanModal.classList.add('hidden');
      adminModal.classList.add('hidden');
      catalogModal.classList.add('hidden');
      if (isEditMode && selectedFurnId) {
        selectedFurnId = null;
        updateEditorUI();
      }
    }
    return;
  }
  if (typing) return;

  // Shortcut Mode Edit
  if (isEditMode) {
    if (e.code === 'KeyR' && selectedFurnId) { e.preventDefault(); rotateSelectedFurniture(); return; }
    if (e.code === 'KeyD' && selectedFurnId && (e.ctrlKey || e.metaKey || !e.repeat)) {
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); duplicateSelectedFurniture(); return; }
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedFurnId) {
      e.preventDefault();
      deleteSelectedFurniture();
      return;
    }
  }

  if (e.code === 'KeyE' && joined && !e.repeat) { e.preventDefault(); interact(); return; }
  if (e.code === 'Space' && joined && !e.repeat) {
    e.preventDefault();
    standUp();
    if (player.y <= 0.001) jumpVelocity = JUMP_SPEED;
  }
  keys[e.code] = true;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
});

window.addEventListener('keyup', (e) => { keys[e.code] = false; });
window.addEventListener('wheel', (e) => {
  camZoom = Math.max(0.55, Math.min(1.7, camZoom + Math.sign(e.deltaY) * 0.08));
}, { passive: true });

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;

  // Jika Mode Edit aktif, cek apakah klik pada objek furnitur
  if (isEditMode) {
    const hitFurnId = getRaycastFurniture(e);
    if (hitFurnId) {
      selectedFurnId = hitFurnId;
      isDraggingFurn = true;
      const obj = furnitureObjects.get(hitFurnId);
      // Hitung offset titik klik pada bidang lantai
      const rect = renderer.domElement.getBoundingClientRect();
      mouseVec.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouseVec.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouseVec, camera);
      if (raycaster.ray.intersectPlane(floorPlane, planeIntersectPoint)) {
        dragPlaneOffset.set(obj.item.x - planeIntersectPoint.x, 0, obj.item.z - planeIntersectPoint.z);
      }
      updateEditorUI();
      renderer.domElement.setPointerCapture(e.pointerId);
      return;
    } else {
      // Jika klik di lantai kosong dalam mode edit, unselect
      if (selectedFurnId) {
        selectedFurnId = null;
        updateEditorUI();
      }
    }
  }

  // Putar kamera orbit normal
  orbitPointer = { id: e.pointerId, x: e.clientX, y: e.clientY };
  renderer.domElement.setPointerCapture(e.pointerId);
  renderer.domElement.classList.add('orbiting');
});

renderer.domElement.addEventListener('pointermove', (e) => {
  // Drag Furnitur
  if (isDraggingFurn && selectedFurnId && isEditMode) {
    const rect = renderer.domElement.getBoundingClientRect();
    mouseVec.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouseVec.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouseVec, camera);
    if (raycaster.ray.intersectPlane(floorPlane, planeIntersectPoint)) {
      let nx = planeIntersectPoint.x + dragPlaneOffset.x;
      let nz = planeIntersectPoint.z + dragPlaneOffset.z;
      // Grid snapping (kelipatan 0.25 meter)
      nx = Math.round(nx * 4) / 4;
      nz = Math.round(nz * 4) / 4;
      nx = Math.max(-16.5, Math.min(16.5, nx));
      nz = Math.max(-10.5, Math.min(10.5, nz));

      const obj = furnitureObjects.get(selectedFurnId);
      if (obj) {
        obj.item.x = nx;
        obj.item.z = nz;
        obj.group.position.set(nx, Number(obj.item.y) || 0, nz);
        selectionRing.position.set(nx, 0.035, nz);
        selectedItemLabel.textContent = `Menggeser: ${getFurnitureName(obj.item.type)} (x: ${nx.toFixed(2)}, z: ${nz.toFixed(2)})`;
      }
    }
    return;
  }

  // Orbit Kamera
  if (!orbitPointer || orbitPointer.id !== e.pointerId) return;
  camAzimuth -= (e.clientX - orbitPointer.x) * 0.006;
  camElevation = Math.max(0.22, Math.min(1.38, camElevation - (e.clientY - orbitPointer.y) * 0.005));
  orbitPointer.x = e.clientX; orbitPointer.y = e.clientY;
});

function endPointer(e) {
  if (isDraggingFurn && selectedFurnId) {
    isDraggingFurn = false;
    const obj = furnitureObjects.get(selectedFurnId);
    if (obj) {
      send({ t: 'furniture_update', item: obj.item });
      addOrUpdateFurnitureItem(obj.item); // Rekonstruksi collider di posisi baru
      updateEditorUI();
    }
  }
  if (orbitPointer && orbitPointer.id === e.pointerId) {
    orbitPointer = null;
    renderer.domElement.classList.remove('orbiting');
  }
}

renderer.domElement.addEventListener('pointerup', endPointer);
renderer.domElement.addEventListener('pointercancel', endPointer);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

joinBtn.onclick = () => {
  const name = nameInput.value.trim() || 'Tamu';
  myName = name;
  try { localStorage.setItem('vo_name', name); } catch { /* abaikan */ }
  if (!audioContext) audioContext = new AudioContext();
  void audioContext.resume();
  let savedAdminKey = '';
  try { savedAdminKey = localStorage.getItem('vo_admin_key') || ''; } catch { /* abaikan */ }
  wantOnline = true;
  if (socket && socket.readyState === WebSocket.OPEN) {
    send({ t: 'join', name, undangan: myInvite, adminCode: savedAdminKey || undefined });
  } else if (!socket || socket.readyState === WebSocket.CLOSED) {
    connect();
  }
};
boardBtn.onclick = () => { renderKanban(); kanbanModal.classList.remove('hidden'); };
voiceBtn.onclick = toggleVoice;
kanbanClose.onclick = () => kanbanModal.classList.add('hidden');
kanbanModal.addEventListener('click', (e) => {
  if (e.target === kanbanModal) kanbanModal.classList.add('hidden');
});

// ---------- loop animasi utama ----------
const clock = new THREE.Clock();
const camTarget = new THREE.Vector3();

function snapCamera() {
  const distance = Math.hypot(13.5, 10) * camZoom;
  const horizontal = distance * Math.cos(camElevation);
  camera.position.set(
    player.x + Math.sin(camAzimuth) * horizontal,
    player.y + distance * Math.sin(camElevation),
    player.z + Math.cos(camAzimuth) * horizontal,
  );
  camera.lookAt(player.x, player.y + 0.5, player.z);
}

function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);

  // Animasi Cincin Seleksi Furnitur
  if (selectionRing.visible) {
    selectionRing.rotation.z += dt * 1.5;
  }

  // Gerakan pemain (hanya jika tidak sedang menggeser furnitur)
  if (joined && !isDraggingFurn) {
    if (!player.sitting && (player.y > 0 || jumpVelocity > 0)) {
      jumpVelocity -= GRAVITY * dt;
      player.y = Math.max(0, player.y + jumpVelocity * dt);
      if (player.y === 0) jumpVelocity = 0;
    }
    let dx = 0, dz = 0;
    if (keys['KeyW'] || keys['ArrowUp']) dz -= 1;
    if (keys['KeyS'] || keys['ArrowDown']) dz += 1;
    if (keys['KeyA'] || keys['ArrowLeft']) dx -= 1;
    if (keys['KeyD'] || keys['ArrowRight']) dx += 1;
    if (dx || dz) {
      if (player.sitting) standUp();
      const moveX = dx * Math.cos(camAzimuth) + dz * Math.sin(camAzimuth);
      const moveZ = -dx * Math.sin(camAzimuth) + dz * Math.cos(camAzimuth);
      dx = moveX; dz = moveZ;
      const l = Math.hypot(dx, dz);
      dx /= l; dz /= l;

      if (hit(player.x, player.z, player.y)) {
        const freed = unstick(player.x, player.z, player.y);
        player.x = freed.x;
        player.z = freed.z;
      }

      const stepX = dx * SPEED * dt;
      const stepZ = dz * SPEED * dt;
      const nx = player.x + stepX;
      const nz = player.z + stepZ;

      if (!hit(nx, nz, player.y)) {
        player.x = nx;
        player.z = nz;
      } else {
        if (!hit(nx, player.z, player.y)) player.x = nx;
        if (!hit(player.x, nz, player.y)) player.z = nz;
      }
      player.ry = Math.atan2(dx, dz);
    }
    const me = users.get(myId);
    if (me) {
      me.group.position.set(player.x, player.y, player.z);
      me.group.rotation.y = player.ry;
      setAvatarPose(me.group, player.sitting);
    }
    const now = performance.now();
    const poseChanged = Math.abs(player.x - lastSentPose.x) > 0.02
      || Math.abs(player.y - lastSentPose.y) > 0.02
      || Math.abs(player.z - lastSentPose.z) > 0.02
      || Math.abs(player.ry - lastSentPose.ry) > 0.05
      || player.sitting !== lastSentPose.sitting;
    if (poseChanged && now - lastMoveSent > 66) {
      lastMoveSent = now;
      lastSentPose = { x: player.x, y: player.y, z: player.z, ry: player.ry, sitting: player.sitting };
      send({ t: 'move', x: +player.x.toFixed(3), y: +player.y.toFixed(3), z: +player.z.toFixed(3), ry: +player.ry.toFixed(3), sitting: player.sitting });
    }
    const target = player.sitting ? null : nearestInteractable();
    if (interactionPrompt) {
      if (!isEditMode) {
        interactionPrompt.textContent = player.sitting ? 'E  Berdiri' : target ? `E  ${target.label}` : '';
        interactionPrompt.classList.toggle('hidden', !player.sitting && !target);
      } else {
        interactionPrompt.classList.add('hidden');
      }
    }
  }

  // Analisis suara mikrofon lokal
  if (localAnalyser && localFreqData && localStream && localStream.getAudioTracks()[0]?.enabled) {
    localAnalyser.getByteFrequencyData(localFreqData);
    let sum = 0;
    for (let i = 0; i < localFreqData.length; i++) sum += localFreqData[i];
    const avg = sum / localFreqData.length;
    const isSpeaking = avg > 10;
    const vol = avg / 255;
    const now = performance.now();

    if (isSpeaking !== isSpeakingLocal || (isSpeaking && now - lastVoiceAnimUpdate > 80)) {
      const stateChanged = isSpeaking !== isSpeakingLocal;
      isSpeakingLocal = isSpeaking;
      lastVoiceAnimUpdate = now;
      updateUserVoiceUI(myId, { micActive: true, speaking: isSpeaking, volume: vol });
      if (stateChanged || now - lastVoiceStatusSent > 250) {
        lastVoiceStatusSent = now;
        send({ t: 'voice_status', active: true, speaking: isSpeaking });
      }
    }
  }

  // Animasi nametag 3D
  for (const u of users.values()) {
    if (u.speaking && u.tag && u.tag.userData.redraw) {
      u.tag.userData.redraw(u.data.name, true, u.micActive !== false, u.volume || 0.5);
    }
  }

  // Interpolasi posisi pemain lain
  const k = 1 - Math.exp(-10 * dt);
  for (const [id, u] of users) {
    if (id === myId) continue;
    u.group.position.x += (u.tx - u.group.position.x) * k;
    u.group.position.y += (u.ty - u.group.position.y) * k;
    u.group.position.z += (u.tz - u.group.position.z) * k;
    u.group.rotation.y = lerpAngle(u.group.rotation.y, u.try_, k);
  }
  updateSpatialAudio();

  // Kamera mengikuti pemain
  const cameraDistance = Math.hypot(13.5, 10) * camZoom;
  const cameraHorizontal = cameraDistance * Math.cos(camElevation);
  camTarget.set(
    player.x + Math.sin(camAzimuth) * cameraHorizontal,
    player.y + cameraDistance * Math.sin(camElevation),
    player.z + Math.cos(camAzimuth) * cameraHorizontal,
  );
  camera.position.lerp(camTarget, 1 - Math.exp(-5 * dt));
  camera.lookAt(player.x, player.y + 0.5, player.z);

  renderer.render(scene, camera);
}

// ---------- undangan ----------
function tampilTanpaUndangan(text) {
  joinOverlay.classList.remove('hidden');
  joinInfo.textContent = text || 'Kantor ini hanya untuk tamu undangan. Buka link undangan yang Anda terima dari pengundang.';
  nameInput.classList.add('hidden');
  joinBtn.classList.add('hidden');
}

async function siapkanUndangan() {
  // Ambil kode dari link (?undangan=...), simpan agar refresh/reconnect tetap bisa,
  // lalu hapus dari alamat supaya tidak ikut terbagi saat menyalin URL.
  const url = new URL(location.href);
  const dariLink = url.searchParams.get('undangan');
  if (dariLink) {
    myInvite = dariLink;
    try { localStorage.setItem('vo_undangan', dariLink); } catch { /* abaikan */ }
    url.searchParams.delete('undangan');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  } else {
    try { myInvite = localStorage.getItem('vo_undangan') || ''; } catch { /* abaikan */ }
  }
  let adminKey = '';
  try { adminKey = localStorage.getItem('vo_admin_key') || ''; } catch { /* abaikan */ }
  let cek;
  try {
    cek = await fetch(`/api/cek?undangan=${encodeURIComponent(myInvite)}`).then((r) => r.json());
  } catch {
    return true; // server tak terjangkau: biarkan alur reconnect biasa
  }
  if (!cek.wajib) return true;
  if (!cek.sah) {
    if (myInvite) { try { localStorage.removeItem('vo_undangan'); } catch { /* abaikan */ } myInvite = ''; }
    if (adminKey) { joinInfo.textContent = 'Masuk dengan kode admin tersimpan.'; return true; }
    tampilTanpaUndangan(dariLink ? 'Link undangan ini tidak sah, sudah dicabut, atau kedaluwarsa. Minta link baru ke pengundang.' : '');
    return false;
  }
  if (cek.admin) {
    joinInfo.textContent = 'Masuk sebagai admin. Kelola undangan di /admin.html';
  } else {
    nameInput.value = cek.nama;
    nameInput.readOnly = true;
    joinInfo.textContent = `Undangan untuk ${cek.nama}. Klik Masuk untuk bergabung.`;
  }
  return true;
}

// ---------- mulai ----------
buildWorld();
try {
  const saved = localStorage.getItem('vo_name');
  if (saved) nameInput.value = saved;
} catch { /* abaikan */ }

const qName = new URLSearchParams(location.search).get('name');
siapkanUndangan().then((boleh) => {
  if (boleh && qName && qName.trim() && !nameInput.readOnly) { nameInput.value = qName.trim().slice(0, 24); joinBtn.click(); }
});
nameInput.focus();
tick();
