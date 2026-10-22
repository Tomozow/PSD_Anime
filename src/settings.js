// 設定の保存・復元。
// - 全体設定 (ループ長・カメラ・背景など) は常に localStorage に保存する。
// - レイヤー設定は PSD ごとに分けて保存し、同じ PSD を開き直したときに復元する。
//   レイヤーの対応付けはレイヤー名で行い、見つからなければ index で拾う。

const KEY_GLOBAL = 'psd-anime/global';
const KEY_LAYERS = 'psd-anime/layers/';
const VERSION = 2; // v2: レイヤーのモーションを motions[] (最大2つ) に変更

function read(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data && data.version === VERSION ? data : null;
  } catch {
    return null;
  }
}

function write(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ ...data, version: VERSION }));
  } catch {
    /* プライベートモードや容量超過は黙って諦める */
  }
}

// ---------------------------------------------------------------- global

export function collectGlobal(ui, state) {
  return {
    loopDuration: state.loopDuration,
    depthStep: state.depthStep,
    cameraMode: ui.cameraMode.value,
    fov: +ui.fov.value,
    bgColor: ui.bgColor.value,
    bgTransparent: ui.bgTransparent.checked,
    showGrid: ui.showGrid.checked,
    global: { ...state.global },
  };
}

export function saveGlobal(ui, state) {
  write(KEY_GLOBAL, collectGlobal(ui, state));
}

export function loadGlobal() {
  return read(KEY_GLOBAL);
}

// data を UI に流し込む。実際の state 反映は input/change イベント経由で行う。
export function applyGlobal(data, ui) {
  if (!data) return;
  const set = (el, value, prop = 'value', ev = 'input') => {
    if (value === undefined || value === null) return;
    el[prop] = value;
    el.dispatchEvent(new Event(ev, { bubbles: true }));
  };
  set(ui.loopDuration, data.loopDuration);
  set(ui.depthStep, data.depthStep);
  set(ui.fov, data.fov);
  set(ui.bgColor, data.bgColor);
  set(ui.bgTransparent, data.bgTransparent, 'checked', 'change');
  set(ui.showGrid, data.showGrid, 'checked', 'change');
  set(ui.cameraMode, data.cameraMode, 'value', 'change');
  if (data.global) {
    set(ui.globalPreset, data.global.preset, 'value', 'change');
    set(ui.globalAmp, data.global.amp);
    set(ui.globalCycles, data.global.cycles);
    set(ui.globalRnd, data.global.rnd);
    set(ui.globalSeed, data.global.seed);
  }
}

// ---------------------------------------------------------------- layers

export function collectLayers(layers) {
  return {
    layers: layers.map((l) => ({
      name: l.def.name,
      cfg: { ...l.cfg, motions: l.cfg.motions.map((m) => ({ ...m })) },
    })),
  };
}

export function saveLayers(docName, layers) {
  if (!docName) return;
  write(KEY_LAYERS + docName, collectLayers(layers));
}

export function loadLayers(docName) {
  return docName ? read(KEY_LAYERS + docName) : null;
}

// 保存済みレイヤー設定を現在のレイヤーへ適用する。戻り値は適用できた件数。
export function applyLayers(data, layers) {
  if (!data?.layers?.length) return 0;
  const byName = new Map();
  data.layers.forEach((entry, i) => {
    if (!byName.has(entry.name)) byName.set(entry.name, { entry, i });
  });

  let applied = 0;
  layers.forEach((layer, i) => {
    const hit = byName.get(layer.def.name) ?? { entry: data.layers[i] };
    if (!hit.entry) return;
    const defaults = layer.cfg.motions;
    Object.assign(layer.cfg, hit.entry.cfg);
    // 欠けているエフェクト枠は既定値で埋める
    layer.cfg.motions = defaults.map((d, k) => ({ ...d, ...(hit.entry.cfg.motions?.[k] ?? {}) }));
    applied++;
  });
  return applied;
}

export function clearLayers(docName) {
  if (docName) localStorage.removeItem(KEY_LAYERS + docName);
}

export function clearAll() {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('psd-anime/')) localStorage.removeItem(key);
  }
}

// ---------------------------------------------------------------- file I/O

export function exportJson(ui, state) {
  const data = {
    version: VERSION,
    doc: state.doc ? { name: state.doc.name, width: state.doc.width, height: state.doc.height } : null,
    ...collectGlobal(ui, state),
    ...collectLayers(state.layers),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (state.doc?.name.replace(/\.psd$/i, '') || 'psd-anime') + '.anime.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export async function importJson(file) {
  const data = JSON.parse(await file.text());
  if (data.version !== VERSION) throw new Error('対応していない設定ファイルの形式です');
  return data;
}
