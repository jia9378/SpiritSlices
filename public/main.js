/* ============================================================
   CT Scan — Volumetric Particle Cloud  |  main.js
   ============================================================ */

// ── Config (runtime params) ───────────────────────────────────────────────
const P = {
  thresh:  35,
  depth:   110,
  size:    4,
  opacity: 0.65,
  jitter:  5,
  speed:   100,
};

const SAMPLE = 2; // pixel stride — lower = more particles (slower)

// ── Scene setup ───────────────────────────────────────────────────────────
const canvas   = document.getElementById('c');
const scene    = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0a);

const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 4000);
camera.position.set(0, 0, 620);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);

// Pivot group — all particles attach here for clean rotation
const pivot = new THREE.Group();
scene.add(pivot);

// ── Orbit controls (manual) ───────────────────────────────────────────────
let dragging = false, lx = 0, ly = 0;
let rotX = 0.15, rotY = 0;

canvas.addEventListener('mousedown',  e => { dragging = true; lx = e.clientX; ly = e.clientY; });
addEventListener('mouseup',           ()  => { dragging = false; });
addEventListener('mousemove', e => {
  if (!dragging) return;
  rotY += (e.clientX - lx) * 0.005;
  rotX += (e.clientY - ly) * 0.004;
  lx = e.clientX; ly = e.clientY;
});
canvas.addEventListener('wheel', e => {
  camera.position.z = Math.max(80, Math.min(1200, camera.position.z + e.deltaY * 0.4));
}, { passive: true });

// Touch
canvas.addEventListener('touchstart',  e => { dragging = true; lx = e.touches[0].clientX; ly = e.touches[0].clientY; });
addEventListener('touchend',           ()  => { dragging = false; });
addEventListener('touchmove', e => {
  if (!dragging) return;
  rotY += (e.touches[0].clientX - lx) * 0.005;
  rotX += (e.touches[0].clientY - ly) * 0.004;
  lx = e.touches[0].clientX; ly = e.touches[0].clientY;
});

// ── Sprite texture factory ────────────────────────────────────────────────
// sharpness 0 = diffuse blob, 1 = tight point
function makeSprite(sharpness) {
  const sz = 64;
  const tc = document.createElement('canvas');
  tc.width = tc.height = sz;
  const tx = tc.getContext('2d');

  const falloff = 0.15 + sharpness * 0.35;           // max 0.50
  const stop2   = Math.min(falloff * 2.0, 0.95);      // always ≤ 1

  const grad = tx.createRadialGradient(sz / 2, sz / 2, 0, sz / 2, sz / 2, sz / 2);
  grad.addColorStop(0,       'rgba(255,255,255,1)');
  grad.addColorStop(falloff, 'rgba(255,255,255,0.85)');
  grad.addColorStop(stop2,   'rgba(255,255,255,0.25)');
  grad.addColorStop(1,       'rgba(255,255,255,0)');

  tx.fillStyle = grad;
  tx.fillRect(0, 0, sz, sz);
  return new THREE.CanvasTexture(tc);
}

const TEX_BONE = makeSprite(1.0);  // tight  — bone / skull
const TEX_GRAY = makeSprite(0.5);  // medium — brain tissue
const TEX_SOFT = makeSprite(0.05);  // diffuse — CSF / haze

// ── Off-screen canvas for pixel extraction ───────────────────────────────
const oc  = document.createElement('canvas');
const octx = oc.getContext('2d', { willReadFrequently: true });

function extractPixels(img) {
  oc.width  = img.naturalWidth;
  oc.height = img.naturalHeight;
  octx.drawImage(img, 0, 0);
  return octx.getImageData(0, 0, oc.width, oc.height);
}

// ── Fast seeded PRNG (Mulberry32) ────────────────────────────────────────
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed  = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t     = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Slice image-data → particle arrays (3 tiers) ─────────────────────────
function sliceToCloud(id, sliceIdx, totalSlices) {
  const { data: d, width: w, height: h } = id;

  const bonePos = [], boneCol = [];
  const grayPos = [], grayCol = [];
  const softPos = [], softCol = [];

  const cx = w / 2, cy = h / 2;
  const z  = ((sliceIdx / (totalSlices - 1)) - 0.5) * P.depth;
  const sliceThick = P.depth / (totalSlices - 1);
  const rng = mulberry32(sliceIdx * 9973 + 1);

  for (let y = 0; y < h; y += SAMPLE) {
    for (let x = 0; x < w; x += SAMPLE) {
      const i   = (y * w + x) * 4;
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (lum < P.thresh) continue;

      const t = lum / 255; // normalised brightness

      const nx = (x - cx) / cx * 160;
      const ny = -(y - cy) / cy * 160;

      // ── Bone / bright structures (t > 0.65) ─────────────────────────
      if (t > 0.65) {
        const js = (1.0 - t) * 0.4;
        bonePos.push(
          nx + (rng() - 0.5) * P.jitter * js,
          ny + (rng() - 0.5) * P.jitter * js,
          z  + (rng() - 0.5) * sliceThick * 0.5
        );
        const wb = (t - 0.65) / 0.35;
        boneCol.push(0.7 + wb * 0.3, 0.7 + wb * 0.3, 0.72 + wb * 0.28);

      // ── Gray matter (0.30 < t ≤ 0.65) ───────────────────────────────
      } else if (t > 0.30) {
        if (rng() > 0.30) {
          const js = 0.6 + ((0.65 - t) / 0.35) * 0.6;
          grayPos.push(
            nx + (rng() - 0.5) * P.jitter * js,
            ny + (rng() - 0.5) * P.jitter * js,
            z  + (rng() - 0.5) * sliceThick * 1.0 + (rng() - 0.5) * P.jitter * 0.5
          );
          const gt = (t - 0.30) / 0.35;
          grayCol.push(0.12 + gt * 0.35, 0.13 + gt * 0.36, 0.15 + gt * 0.38);
        }

      // ── Soft tissue / CSF haze (thresh..0.30) ───────────────────────
      } else {
        if (rng() > 0.55) {
          softPos.push(
            nx + (rng() - 0.5) * P.jitter * 2.2,
            ny + (rng() - 0.5) * P.jitter * 2.2,
            z  + (rng() - 0.5) * sliceThick * 2.0 + (rng() - 0.5) * P.jitter * 1.5
          );
          const st = t / 0.30;
          softCol.push(0.05 + st * 0.10, 0.06 + st * 0.11, 0.07 + st * 0.13);
        }
      }
    }
  }

  return { bonePos, boneCol, grayPos, grayCol, softPos, softCol };
}

// ── Mesh management ───────────────────────────────────────────────────────
let meshBone = null, meshGray = null, meshSoft = null;
let clouds   = [];         // per-slice cloud data
let totalSlices = 0;

function makePts(pos, col, tex, size, opacity) {
  if (!pos.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({
    size,
    vertexColors:  true,
    map:           tex,
    alphaTest:     0.005,
    transparent:   true,
    opacity,
    blending:      THREE.AdditiveBlending,
    depthWrite:    false,
    sizeAttenuation: true,
  });
  return new THREE.Points(geo, mat);
}

function buildMesh() {
  [meshBone, meshGray, meshSoft].forEach(m => {
    if (m) { pivot.remove(m); m.geometry.dispose(); m.material.dispose(); }
  });
  meshBone = meshGray = meshSoft = null;

  const bp = [], bc = [], gp = [], gc = [], sp = [], sc = [];
  clouds.forEach(c => {
    if (!c) return;
    bp.push(...c.bonePos); bc.push(...c.boneCol);
    gp.push(...c.grayPos); gc.push(...c.grayCol);
    sp.push(...c.softPos); sc.push(...c.softCol);
  });

  const sz = P.size * 0.6;
  if (bp.length) { meshBone = makePts(bp, bc, TEX_BONE, sz * 0.8,  P.opacity * 1.0);  pivot.add(meshBone); }
  if (gp.length) { meshGray = makePts(gp, gc, TEX_GRAY, sz * 1.0,  P.opacity * 0.75); pivot.add(meshGray); }
  if (sp.length) { meshSoft = makePts(sp, sc, TEX_SOFT,  sz * 1.6, P.opacity * 0.40); pivot.add(meshSoft); }

  const total = bp.length / 3 + gp.length / 3 + sp.length / 3;
  // particle count display removed — showing dataset stats instead
}

// ── Scan animation ────────────────────────────────────────────────────────
let scanning  = false;
let scanIdx   = 0;
const scanLine = document.getElementById('scan-line');
const dots     = [];

function startScan() {
  if (scanning || totalSlices === 0) return;
  scanning = true;
  scanIdx  = 0;
  clouds   = new Array(totalSlices).fill(null);
  buildMesh();
  scanLine.style.opacity = '1';
  nextScan();
}

function nextScan() {
  if (scanIdx >= totalSlices) {
    scanning = false;
    scanLine.style.opacity = '0';
    // Show the brain overlay link
    var bl = document.getElementById('brain-link');
    if (bl) bl.classList.add('visible');
    return;
  }
  const i = scanIdx;
  clouds[i] = sliceToCloud(imageDataStore[i], i, totalSlices);
  buildMesh();
  dots.forEach((d, j) => {
    d.className = 'sdot' + (j < i ? ' done' : '') + (j === i ? ' active' : '');
  });
  scanLine.style.top = (i / (totalSlices - 1) * 85 + 5) + '%';
  // slice count display removed
  scanIdx++;
  setTimeout(nextScan, P.speed);
}

// ── Image loading ─────────────────────────────────────────────────────────
let imageDataStore = [];

function loadSlices(urls) {
  totalSlices = urls.length;
  imageDataStore = new Array(totalSlices);
  clouds = new Array(totalSlices).fill(null);

  // rebuild slice dots
  const bar = document.getElementById('slice-bar');
  bar.innerHTML = '';
  dots.length = 0;
  urls.forEach(() => {
    const d = document.createElement('div');
    d.className = 'sdot';
    bar.appendChild(d);
    dots.push(d);
  });

  // slice count display removed
  setLoadStatus(`LOADING ${totalSlices} SLICES…`);

  let loaded = 0;
  const promises = urls.map((url, idx) => new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      imageDataStore[idx] = extractPixels(img);
      loaded++;
      const pct = Math.round(loaded / totalSlices * 100);
      document.getElementById('prog-fill').style.width = pct + '%';
      document.getElementById('load-pct').textContent  = pct + ' %';
      resolve();
    };
    img.onerror = () => { console.warn('Failed to load:', url); resolve(); };
    img.src = url;
  }));

  Promise.all(promises).then(() => {
    hideLoading();
    for (let i = 0; i < totalSlices; i++) {
      if (imageDataStore[i]) clouds[i] = sliceToCloud(imageDataStore[i], i, totalSlices);
    }
    buildMesh();
    dots.forEach(d => d.className = 'sdot done');
    // slice count display removed
    setTimeout(startScan, 600);
  });
}

// ── Fetch slice list from server ──────────────────────────────────────────
async function fetchAndLoad() {
  try {
    setLoadStatus('FETCHING SLICE LIST…');
    const res  = await fetch('/api/slices');
    const data = await res.json();

    if (!data.slices || data.slices.length === 0) {
      setLoadStatus('NO SLICES FOUND IN /assets OR /uploads');
      return;
    }
    loadSlices(data.slices);
  } catch (err) {
    setLoadStatus('SERVER ERROR — IS server.js RUNNING?');
    console.error(err);
  }
}

// ── File upload via Multer ────────────────────────────────────────────────
var fileInput = document.getElementById('file-input');
if (fileInput) fileInput.addEventListener('change', async e => {
  const files = Array.from(e.target.files);
  if (!files.length) return;

  showLoading();
  setLoadStatus(`UPLOADING ${files.length} FILES…`);

  const form = new FormData();
  files.forEach(f => form.append('slices', f));

  try {
    const res  = await fetch('/api/upload', { method: 'POST', body: form });
    const data = await res.json();
    if (data.success) {
      loadSlices(data.files);
    } else {
      setLoadStatus('UPLOAD FAILED');
    }
  } catch (err) {
    setLoadStatus('UPLOAD ERROR');
    console.error(err);
  }

  // reset input so same files can be re-selected
  e.target.value = '';
});

// ── Loading overlay helpers ───────────────────────────────────────────────
function showLoading() {
  const el = document.getElementById('loading');
  el.classList.remove('hidden');
  document.getElementById('prog-fill').style.width = '0%';
  document.getElementById('load-pct').textContent  = '0 %';
}

function hideLoading() {
  document.getElementById('loading').classList.add('hidden');
}

function setLoadStatus(msg) {
  document.getElementById('load-status').textContent = msg;
}

// ── Controls ──────────────────────────────────────────────────────────────
function bindSlider(id, valId, key, callback) {
  const el = document.getElementById(id);
  el.addEventListener('input', () => {
    P[key] = +el.value;
    document.getElementById(valId).textContent = el.value;
    callback();
  });
}

function rebuildAll() {
  for (let i = 0; i < totalSlices; i++) {
    if (imageDataStore[i]) clouds[i] = sliceToCloud(imageDataStore[i], i, totalSlices);
  }
  buildMesh();
}

bindSlider('r-thresh',  'v-thresh',  'thresh',  rebuildAll);
bindSlider('r-depth',   'v-depth',   'depth',   rebuildAll);
bindSlider('r-jitter',  'v-jitter',  'jitter',  rebuildAll);
bindSlider('r-size',    'v-size',    'size',    buildMesh);
bindSlider('r-opacity', 'v-opacity', 'opacity', buildMesh);
bindSlider('r-speed',   'v-speed',   'speed',   () => {}); // live — picked up by setTimeout

document.getElementById('btn-replay').addEventListener('click', startScan);

// ── Render loop ───────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  if (!dragging) rotY += 0.0018;
  pivot.rotation.x = rotX;
  pivot.rotation.y = rotY;
  renderer.render(scene, camera);
}
animate();

// ── Resize ────────────────────────────────────────────────────────────────
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ── Kick off ──────────────────────────────────────────────────────────────
fetchAndLoad();