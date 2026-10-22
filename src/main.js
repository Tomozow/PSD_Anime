import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadPsd } from './psdLoader.js';
import { PRESETS, PRESET_KEYS } from './presets.js';
import * as settings from './settings.js';
import * as store from './store.js';
import { exportLive2d, buildFiles, download as downloadFile } from './live2d.js';

const PX = 1 / 100; // 1px = 0.01 unit

// ---------------------------------------------------------------- state
const state = {
  doc: null,          // { name, width, height, layers[] }
  layers: [],         // { def, group, mesh, material, base:{x,y}, cfg }
  root: new THREE.Group(),
  loopDuration: 4,
  depthStep: 0.15,
  playing: true,
  u: 0,               // 0..1 のループ位相
  global: { preset: 'none', amp: 0.5, cycles: 1, rnd: 0, seed: 1 },
};

// ---------------------------------------------------------------- three
const viewport = document.getElementById('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#101014');
scene.add(state.root);

const grid = new THREE.GridHelper(10, 20, 0x444455, 0x2a2a34);
grid.visible = false;
scene.add(grid);

let camera = makeCamera('persp', 35);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

function makeCamera(mode, fov) {
  const aspect = viewport.clientWidth / Math.max(1, viewport.clientHeight);
  if (mode === 'ortho') {
    const h = 3;
    return new THREE.OrthographicCamera(-h * aspect, h * aspect, h, -h, 0.01, 1000);
  }
  return new THREE.PerspectiveCamera(fov, aspect, 0.01, 1000);
}

function rebuildCamera() {
  const mode = ui.cameraMode.value;
  const fov = +ui.fov.value;
  const pos = camera.position.clone();
  camera = makeCamera(mode, fov);
  camera.position.copy(pos);
  controls.object = camera;
  controls.update();
  resize();
}

function resize() {
  const w = viewport.clientWidth;
  const h = Math.max(1, viewport.clientHeight);
  renderer.setSize(w, h, false);
  const aspect = w / h;
  if (camera.isOrthographicCamera) {
    const v = 3;
    camera.left = -v * aspect; camera.right = v * aspect;
    camera.top = v; camera.bottom = -v;
  } else {
    camera.aspect = aspect;
  }
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);

// ---------------------------------------------------------------- UI refs
const ui = {
  file: document.getElementById('file'),
  docinfo: document.getElementById('docinfo'),
  loopDuration: document.getElementById('loopDuration'),
  depthStep: document.getElementById('depthStep'),
  depthStepOut: document.getElementById('depthStepOut'),
  cameraMode: document.getElementById('cameraMode'),
  fov: document.getElementById('fov'),
  fovOut: document.getElementById('fovOut'),
  bgColor: document.getElementById('bgColor'),
  bgTransparent: document.getElementById('bgTransparent'),
  showGrid: document.getElementById('showGrid'),
  globalPreset: document.getElementById('globalPreset'),
  globalAmp: document.getElementById('globalAmp'),
  globalAmpOut: document.getElementById('globalAmpOut'),
  globalCycles: document.getElementById('globalCycles'),
  globalRnd: document.getElementById('globalRnd'),
  globalRndOut: document.getElementById('globalRndOut'),
  globalSeed: document.getElementById('globalSeed'),
  layers: document.getElementById('layers'),
  layerCount: document.getElementById('layerCount'),
  playBtn: document.getElementById('playBtn'),
  scrub: document.getElementById('scrub'),
  timeLabel: document.getElementById('timeLabel'),
  resetCam: document.getElementById('resetCam'),
  recBtn: document.getElementById('recBtn'),
  drop: document.getElementById('drop'),
  autoSave: document.getElementById('autoSave'),
  exportBtn: document.getElementById('exportBtn'),
  importFile: document.getElementById('importFile'),
  resetSettings: document.getElementById('resetSettings'),
  saveinfo: document.getElementById('saveinfo'),
  l2dFps: document.getElementById('l2dFps'),
  l2dExport: document.getElementById('l2dExport'),
  l2dGuide: document.getElementById('l2dGuide'),
  l2dinfo: document.getElementById('l2dinfo'),
  l2dlinks: document.getElementById('l2dlinks'),
};

// ---------------------------------------------------------------- autosave
// 触っている最中の値もこぼさないよう、変更のたびに (少し遅らせて) 保存する。
let saveTimer = null;
let restoring = false;

function scheduleSave() {
  if (restoring || !ui.autoSave.checked) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}

function saveNow() {
  if (!ui.autoSave.checked) return;
  settings.saveGlobal(ui, state);
  if (state.doc) settings.saveLayers(state.doc.name, state.layers);
  const t = new Date();
  ui.saveinfo.textContent = `自動保存しました (${t.toLocaleTimeString('ja-JP')})`;
}

// サイドバー上のあらゆる操作を拾う。個別に配線しなくても取りこぼさない。
document.getElementById('sidebar').addEventListener('input', scheduleSave);
document.getElementById('sidebar').addEventListener('change', scheduleSave);
// タブを閉じる直前は待たずに書き出す。
window.addEventListener('pagehide', () => {
  clearTimeout(saveTimer);
  if (ui.autoSave.checked) saveNow();
});

// ---------------------------------------------------------------- build scene from PSD
function buildScene(doc) {
  // 既存を破棄
  for (const l of state.layers) {
    l.mesh.geometry.dispose();
    l.material.map.dispose();
    l.material.dispose();
  }
  state.root.clear();
  state.layers = [];
  state.doc = doc;

  const cx = doc.width / 2;
  const cy = doc.height / 2;

  doc.layers.forEach((def, i) => {
    const texture = new THREE.CanvasTexture(def.canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    const geometry = new THREE.PlaneGeometry(def.width * PX, def.height * PX);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = i;

    const group = new THREE.Group();
    group.add(mesh);
    state.root.add(group);

    const layer = {
      def,
      group,
      mesh,
      material,
      index: i,
      base: {
        x: (def.left + def.width / 2 - cx) * PX,
        y: -(def.top + def.height / 2 - cy) * PX,
      },
      cfg: {
        visible: !def.hiddenInPsd,
        // 1レイヤーにつき2つまでエフェクトを重ねられる
        motions: [
          { preset: 'none', amp: 0.3, cycles: 1, phase: 0, rnd: 0, seed: i * 2 + 1 },
          { preset: 'none', amp: 0.3, cycles: 1, phase: 0, rnd: 0, seed: i * 2 + 2 },
        ],
        pivot: 'center',
        depth: i, // 奥行き倍率 (レイヤー間隔に掛かる)
        opacity: def.opacity,
      },
    };
    state.layers.push(layer);
  });

  // 同じPSDの前回設定があれば復元する
  const saved = settings.loadLayers(doc.name);
  const restored = settings.applyLayers(saved, state.layers);

  ui.layerCount.textContent = doc.layers.length;
  ui.docinfo.textContent = `${doc.name} — ${doc.width}×${doc.height}px / ${doc.layers.length}レイヤー`;
  ui.saveinfo.textContent = restored ? `前回の設定を復元しました (${restored}レイヤー)` : '';
  buildLayerUI();
  frameCamera();
}

function frameCamera() {
  if (!state.doc) return;
  const h = state.doc.height * PX;
  const w = state.doc.width * PX;
  const aspect = viewport.clientWidth / Math.max(1, viewport.clientHeight);
  const fit = Math.max(h, w / aspect) * 0.65;
  const dist = camera.isPerspectiveCamera
    ? fit / Math.tan((camera.fov * Math.PI) / 360) * 1.15
    : 5;
  camera.position.set(0, 0, dist);
  controls.target.set(0, 0, 0);
  controls.update();
}

// ---------------------------------------------------------------- layer UI
function buildLayerUI() {
  ui.layers.innerHTML = '';
  // 上のレイヤーが上に並ぶよう逆順表示
  [...state.layers].reverse().forEach((layer) => {
    ui.layers.appendChild(layerRow(layer));
  });
}

function layerRow(layer) {
  const el = document.createElement('div');
  el.className = 'layer' + (layer.cfg.visible ? '' : ' off');

  const optionHtml = PRESET_KEYS
    .map((k) => `<option value="${k}">${PRESETS[k].label}</option>`)
    .join('');

  el.innerHTML = `
    <div class="layer-head">
      <input type="checkbox" class="vis" ${layer.cfg.visible ? 'checked' : ''} title="表示" />
      <canvas class="thumb"></canvas>
      <span class="name" title="${escapeHtml(layer.def.name)}">${escapeHtml(layer.def.name)}</span>
      <span class="dim">▾</span>
    </div>
    <div class="layer-body">
      ${layer.cfg.motions.map((m, i) => `
      <div class="motion" data-i="${i}">
        <h4>エフェクト ${i + 1}</h4>
        <div class="row"><label>モーション</label><select class="preset">${optionHtml}</select></div>
        <div class="row"><label>強さ</label><input type="range" class="amp" min="0" max="2" step="0.01" value="${m.amp}"><output>${m.amp.toFixed(2)}</output></div>
        <div class="row"><label>周期数</label><input type="number" class="cycles" min="1" max="8" step="1" value="${m.cycles}"></div>
        <div class="row"><label>位相ずれ</label><input type="range" class="phase" min="0" max="1" step="0.01" value="${m.phase}"><output>${m.phase.toFixed(2)}</output></div>
        <div class="row"><label>ランダム度</label><input type="range" class="rnd" min="0" max="1" step="0.01" value="${m.rnd}"><output>${m.rnd.toFixed(2)}</output></div>
        <div class="row"><label>シード</label><input type="number" class="seed" min="1" max="999" step="1" value="${m.seed}"><button class="reseed" title="別のランダムパターンを引き直す">引き直す</button></div>
      </div>`).join('')}
      <div class="row"><label>基点</label><select class="pivot">
        <option value="center">レイヤー中央</option>
        <option value="doc">画像の中心軸</option>
        <option value="bottom">レイヤー下端</option>
        <option value="top">レイヤー上端</option>
        <option value="left">レイヤー左端</option>
        <option value="right">レイヤー右端</option>
      </select></div>
      <div class="row"><label>奥行き</label><input type="number" class="depth" step="0.5" value="${layer.cfg.depth}"></div>
      <div class="row"><label>不透明度</label><input type="range" class="opacity" min="0" max="1" step="0.01" value="${layer.cfg.opacity}"><output>${layer.cfg.opacity.toFixed(2)}</output></div>
    </div>`;

  el.querySelectorAll('.motion').forEach((box, i) => {
    const m = layer.cfg.motions[i];
    box.querySelector('.preset').value = m.preset;
    bind(box, '.preset', 'change', (v) => (m.preset = v));
    bindNum(box, '.amp', (v) => (m.amp = v), 2);
    bindNum(box, '.cycles', (v) => (m.cycles = Math.max(1, v || 1)));
    bindNum(box, '.phase', (v) => (m.phase = v), 2);
    bindNum(box, '.rnd', (v) => (m.rnd = v), 2);
    bindNum(box, '.seed', (v) => (m.seed = Math.max(1, v || 1)));
    box.querySelector('.reseed').addEventListener('click', () => {
      const input = box.querySelector('.seed');
      input.value = 1 + Math.floor(Math.random() * 999);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });

  el.querySelector('.pivot').value = layer.cfg.pivot;
  drawThumb(el.querySelector('.thumb'), layer.def.canvas);

  el.querySelector('.layer-head').addEventListener('click', (e) => {
    if (e.target.classList.contains('vis')) return;
    el.classList.toggle('open');
  });
  el.querySelector('.vis').addEventListener('change', (e) => {
    layer.cfg.visible = e.target.checked;
    el.classList.toggle('off', !layer.cfg.visible);
  });

  bind(el, '.pivot', 'change', (v) => (layer.cfg.pivot = v));
  bindNum(el, '.depth', (v) => (layer.cfg.depth = v));
  bindNum(el, '.opacity', (v) => (layer.cfg.opacity = v), 2);

  return el;
}

function bind(root, sel, ev, fn) {
  root.querySelector(sel).addEventListener(ev, (e) => fn(e.target.value));
}

function bindNum(root, sel, fn, digits) {
  const input = root.querySelector(sel);
  const out = input.nextElementSibling;
  input.addEventListener('input', (e) => {
    const v = +e.target.value;
    fn(v);
    if (out && out.tagName === 'OUTPUT') out.textContent = digits ? v.toFixed(digits) : v;
  });
}

function drawThumb(canvas, src) {
  const size = 26 * (devicePixelRatio || 1);
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const s = Math.min(size / src.width, size / src.height);
  const w = src.width * s;
  const h = src.height * s;
  ctx.drawImage(src, (size - w) / 2, (size - h) / 2, w, h);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- animation
function applyFrame(u) {
  // 全体モーション
  state.root.position.set(0, 0, 0);
  state.root.rotation.set(0, 0, 0);
  state.root.scale.set(1, 1, 1);
  state.root.userData.opacityMul = 1;
  const gp = PRESETS[state.global.preset];
  if (gp) gp.apply(state.root, u, state.global.amp, state.global.cycles, state.global.rnd, state.global.seed);
  const globalOpacity = state.root.userData.opacityMul;

  for (const layer of state.layers) {
    const { cfg, group, mesh, material, base } = layer;
    group.visible = cfg.visible;
    if (!cfg.visible) continue;

    // 基点オフセット: group の原点を基点に置き、mesh をその分ずらす。
    // (ox, oy) は「基点 → レイヤー中心」のベクトル。
    const hw = layer.def.width * PX / 2;
    const hh = layer.def.height * PX / 2;
    let ox = 0, oy = 0;
    if (cfg.pivot === 'bottom') oy = hh;
    else if (cfg.pivot === 'top') oy = -hh;
    else if (cfg.pivot === 'left') ox = hw;
    else if (cfg.pivot === 'right') ox = -hw;
    // 画像(キャンバス)の中心軸を基点にする。レイヤーが画像中心のまわりを回る。
    else if (cfg.pivot === 'doc') { ox = base.x; oy = base.y; }
    mesh.position.set(ox, oy, 0);

    group.position.set(base.x - ox, base.y - oy, cfg.depth * state.depthStep);
    group.rotation.set(0, 0, 0);
    group.scale.set(1, 1, 1);
    group.userData.opacityMul = 1;

    // エフェクトを順に重ねがけする（プリセットはすべて加算/乗算で定義してある）
    for (const m of cfg.motions) {
      const preset = PRESETS[m.preset];
      if (!preset || m.preset === 'none') continue;
      preset.apply(group, (u + m.phase) % 1, m.amp, m.cycles, m.rnd ?? 0, m.seed ?? 1);
    }
    material.opacity = cfg.opacity * group.userData.opacityMul * globalOpacity;
  }
}

let last = performance.now();
function tick(now) {
  requestAnimationFrame(tick);
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  if (state.playing) {
    state.u = (state.u + dt / state.loopDuration) % 1;
    ui.scrub.value = state.u;
    ui.timeLabel.textContent = (state.u * state.loopDuration).toFixed(2) + 's';
  }

  applyFrame(state.u);
  controls.update();
  renderer.render(scene, camera);

  if (recorder && recStart != null && now - recStart >= state.loopDuration * 1000) {
    stopRecording();
  }
}
requestAnimationFrame(tick);

// ---------------------------------------------------------------- global UI wiring
ui.file.addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (f) openFile(f);
});

['dragenter', 'dragover'].forEach((ev) =>
  window.addEventListener(ev, (e) => { e.preventDefault(); ui.drop.classList.add('on'); }));
['dragleave', 'drop'].forEach((ev) =>
  window.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === document.documentElement) ui.drop.classList.remove('on'); }));
window.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) openFile(f);
});

async function openFile(file, { remember = true } = {}) {
  if (!/\.psd$/i.test(file.name)) {
    alert('PSDファイルを選択してください。');
    return;
  }
  ui.docinfo.textContent = '読み込み中…';
  try {
    const doc = await loadPsd(file);
    if (!doc.layers.length) throw new Error('描画可能なレイヤーが見つかりませんでした（統合済みPSDの可能性があります）');
    buildScene(doc);
    // 次回リロード時に同じPSDから再開できるよう本体も保持しておく
    if (remember && ui.autoSave.checked) store.saveLastFile(file);
  } catch (err) {
    console.error(err);
    ui.docinfo.textContent = 'エラー: ' + err.message;
  }
}

ui.loopDuration.addEventListener('input', (e) => (state.loopDuration = Math.max(0.1, +e.target.value)));
ui.depthStep.addEventListener('input', (e) => {
  state.depthStep = +e.target.value;
  ui.depthStepOut.textContent = state.depthStep.toFixed(2);
});
ui.cameraMode.addEventListener('change', rebuildCamera);
ui.fov.addEventListener('input', (e) => {
  ui.fovOut.textContent = e.target.value;
  if (camera.isPerspectiveCamera) {
    camera.fov = +e.target.value;
    camera.updateProjectionMatrix();
  }
});
ui.bgColor.addEventListener('input', updateBackground);
ui.bgTransparent.addEventListener('change', updateBackground);
function updateBackground() {
  scene.background = ui.bgTransparent.checked ? null : new THREE.Color(ui.bgColor.value);
  renderer.setClearAlpha(ui.bgTransparent.checked ? 0 : 1);
}
ui.showGrid.addEventListener('change', (e) => (grid.visible = e.target.checked));

ui.globalPreset.addEventListener('change', (e) => (state.global.preset = e.target.value));
ui.globalAmp.addEventListener('input', (e) => {
  state.global.amp = +e.target.value;
  ui.globalAmpOut.textContent = state.global.amp.toFixed(2);
});
ui.globalCycles.addEventListener('input', (e) => (state.global.cycles = Math.max(1, +e.target.value)));
ui.globalRnd.addEventListener('input', (e) => {
  state.global.rnd = +e.target.value;
  ui.globalRndOut.textContent = state.global.rnd.toFixed(2);
});
ui.globalSeed.addEventListener('input', (e) => (state.global.seed = Math.max(1, +e.target.value)));

ui.playBtn.addEventListener('click', () => {
  state.playing = !state.playing;
  ui.playBtn.textContent = state.playing ? '⏸ 一時停止' : '▶ 再生';
});
ui.scrub.addEventListener('input', (e) => {
  state.playing = false;
  ui.playBtn.textContent = '▶ 再生';
  state.u = +e.target.value;
  ui.timeLabel.textContent = (state.u * state.loopDuration).toFixed(2) + 's';
});
ui.resetCam.addEventListener('click', frameCamera);

// ---------------------------------------------------------------- recording
let recorder = null;
let recChunks = [];
let recStart = null;

ui.recBtn.addEventListener('click', () => {
  if (recorder) { stopRecording(); return; }
  startRecording();
});

function startRecording() {
  const stream = renderer.domElement.captureStream(60);
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) { alert('このブラウザは録画に対応していません。'); return; }

  recChunks = [];
  recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
  recorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
  recorder.onstop = () => {
    const blob = new Blob(recChunks, { type: 'video/webm' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (state.doc?.name.replace(/\.psd$/i, '') || 'psd-anime') + '-loop.webm';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  state.u = 0;
  state.playing = true;
  ui.playBtn.textContent = '⏸ 一時停止';
  recStart = performance.now();
  recorder.start();
  ui.recBtn.classList.add('rec');
  ui.recBtn.textContent = '■ 録画中…';
}

function stopRecording() {
  if (!recorder) return;
  recorder.stop();
  recorder = null;
  recStart = null;
  ui.recBtn.classList.remove('rec');
  ui.recBtn.textContent = '🎬 1ループ録画 (webm)';
}

// ---------------------------------------------------------------- settings UI
ui.exportBtn.addEventListener('click', () => settings.exportJson(ui, state));

ui.importFile.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = await settings.importJson(file);
    restoring = true;
    settings.applyGlobal(data, ui);
    restoring = false;
    const n = settings.applyLayers(data, state.layers);
    buildLayerUI();
    ui.saveinfo.textContent = `設定を読み込みました (${n}レイヤー)`;
    saveNow();
  } catch (err) {
    restoring = false;
    console.error(err);
    ui.saveinfo.textContent = '読み込みエラー: ' + err.message;
  }
});

ui.resetSettings.addEventListener('click', () => {
  if (!confirm('このPSDの保存済み設定を削除して、初期状態に戻します。よろしいですか？')) return;
  if (state.doc) {
    settings.clearLayers(state.doc.name);
    buildScene(state.doc); // 保存済みが無い状態で組み直す = 初期値
  }
  ui.saveinfo.textContent = '設定をリセットしました';
});

ui.autoSave.addEventListener('change', () => {
  if (ui.autoSave.checked) {
    saveNow();
  } else {
    ui.saveinfo.textContent = '自動保存はオフです';
    store.clearLastFile();
  }
});

// ブラウザに自動ダウンロードを止められても取り出せるよう、手動保存リンクを残す。
function showL2dLinks(files) {
  ui.l2dlinks.innerHTML = '保存されない場合はこちら: ';
  for (const file of files) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([file.text], { type: file.type }));
    a.download = file.name;
    a.textContent = file.name.endsWith('.html') ? '手順書(.html)'
      : file.name.endsWith('.csv') ? 'パラメータ一覧(.csv)'
      : 'motion3.json';
    a.style.marginRight = '8px';
    ui.l2dlinks.appendChild(a);
  }
}

ui.l2dExport.addEventListener('click', async () => {
  try {
    ui.l2dinfo.textContent = '書き出し中…';
    const { built, files } = await exportLive2d(state, { fps: +ui.l2dFps.value });
    const { CurveCount, TotalPointCount } = built.motion.Meta;
    ui.l2dinfo.textContent =
      `書き出しました: ${CurveCount}カーブ / ${TotalPointCount}点 ` +
      `(パラメータ${built.paramDocs.length} + パーツ不透明度${built.partDocs.length})`;
    showL2dLinks(files);
  } catch (err) {
    console.error(err);
    ui.l2dinfo.textContent = 'エラー: ' + err.message;
  }
});

// 手順書はダウンロードせずその場で開けたほうが早い。
ui.l2dGuide.addEventListener('click', () => {
  try {
    const { files } = buildFiles(state, { fps: +ui.l2dFps.value });
    const url = URL.createObjectURL(new Blob([files[1].text], { type: files[1].type }));
    const win = window.open(url, '_blank');
    // ポップアップを止められたら保存にフォールバックする
    if (win) {
      ui.l2dinfo.textContent = '手順書を新しいタブで開きました（保存は下のリンクから）';
    } else {
      downloadFile(files[1]);
      ui.l2dinfo.textContent = `新しいタブを開けなかったので保存しました: ${files[1].name}`;
    }
    showL2dLinks(files);
  } catch (err) {
    console.error(err);
    ui.l2dinfo.textContent = 'エラー: ' + err.message;
  }
});

// ---------------------------------------------------------------- startup
// DOM の初期値 (ブラウザによるフォーム復元も含む) を state に反映してから、保存値を上書き適用する。
function syncGlobalFromUi() {
  [ui.loopDuration, ui.depthStep, ui.fov, ui.bgColor, ui.globalAmp, ui.globalCycles, ui.globalRnd, ui.globalSeed]
    .forEach((el) => el.dispatchEvent(new Event('input', { bubbles: true })));
  [ui.cameraMode, ui.bgTransparent, ui.showGrid, ui.globalPreset]
    .forEach((el) => el.dispatchEvent(new Event('change', { bubbles: true })));
}

async function boot() {
  restoring = true;
  syncGlobalFromUi();
  settings.applyGlobal(settings.loadGlobal(), ui);
  restoring = false;

  updateBackground();
  resize();

  const last = await store.loadLastFile();
  if (last) {
    await openFile(last, { remember: false });
    ui.saveinfo.textContent = `前回の作業内容を復元しました（${last.name}）`;
  }
}
boot();

// デバッグ / 自動テスト用の最小API
window.psdAnime = {
  state,
  openFile,
  async openUrl(url) {
    const res = await fetch(url);
    const blob = await res.blob();
    return openFile(new File([blob], url.split('/').pop(), { type: 'image/vnd.adobe.photoshop' }));
  },
};

document.getElementById('sampleBtn').addEventListener('click', () => window.psdAnime.openUrl('sample.psd'));
