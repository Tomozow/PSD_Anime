// Live2D Cubism 向けの書き出し。
//
// Cubism のモデル編集ファイル (.cmo3) とアニメーション編集ファイル (.can3) は
// 非公開フォーマットのため生成できない。代わりに、公開仕様であり Cubism Editor / Animator に
// そのまま読み込めて、読み込み後もキーフレームを編集できる .motion3.json を出力する。
//
//   - 不透明度のアニメーション → Target "PartOpacity" (PSD読み込みで作られるパーツIDに直接効く)
//   - 移動・回転・拡大縮小       → Target "Parameter"  (自分で作ったパラメータに割り当てて使う)
//
// あわせて、Cubism Editor 側の作業手順を「パーツごと」に分けた HTML で出力する。
// (Markdown だとテキストエディタで開いたときに表が崩れて読めないため)

import { PRESETS } from './presets.js';

const PX = 1 / 100;      // main.js と同じ「1px = 0.01 unit」
const RAD2DEG = 180 / Math.PI;

// three.js に依存せずプリセットを評価するための最小オブジェクト
function makeTarget() {
  return {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: {
      x: 1, y: 1, z: 1,
      multiplyScalar(v) { this.x *= v; this.y *= v; this.z *= v; return this; },
    },
    userData: { opacityMul: 1 },
  };
}

// u は 0..1 (終端の 1 を含む)。
// 描画側と違って位相に % 1 を掛けないのがポイント。掛けてしまうと連続回転が
// ループ終端で 0 に巻き戻り、最後の1フレームだけ逆回転するカーブになってしまう。
// プリセットはどれも周期1なので、揺れ系は u=0 と u=1 が一致し、回転系だけが
// きれいな1本のスロープとして書き出される。
function evalMotions(motions, u) {
  const t = makeTarget();
  for (const m of motions) {
    const preset = PRESETS[m.preset];
    if (!preset || m.preset === 'none') continue;
    preset.apply(t, u + (m.phase ?? 0), m.amp, m.cycles, m.rnd ?? 0, m.seed ?? 1);
  }
  return t;
}

// チャンネル定義。value は評価結果から Live2D 向けの単位へ変換する。
// eps は「この誤差までは1本のカーブで近似してよい」という許容値（見た目に出ない範囲）。
//
// 拡大率は Live2D のパラメータ値としては扱いにくい（0.59〜1.41 / デフォルト1 のような
// 半端な範囲になる）ので、-1〜1 (0 = 等倍) に正規化して書き出す。
// 実際の倍率は手順書のキーフォーム指示文に出す。角度(度)と移動(px)はそのままのほうが
// 直感的なので変換しない。
const CHANNELS = [
  { key: 'PosX',   label: '横移動 (px)',      unit: 'px',  eps: 0.25,  value: (t) => t.position.x / PX },
  { key: 'PosY',   label: '縦移動 (px)',      unit: 'px',  eps: 0.25,  value: (t) => t.position.y / PX },
  { key: 'PosZ',   label: '奥行き (px相当)',  unit: 'px',  eps: 0.25,  value: (t) => t.position.z / PX },
  { key: 'AngleX', label: 'X軸回転 (度)',     unit: 'deg', eps: 0.15,  value: (t) => t.rotation.x * RAD2DEG },
  { key: 'AngleY', label: 'Y軸回転 (度)',     unit: 'deg', eps: 0.15,  value: (t) => t.rotation.y * RAD2DEG },
  { key: 'AngleZ', label: 'Z軸回転 (度)',     unit: 'deg', eps: 0.15,  value: (t) => t.rotation.z * RAD2DEG },
  { key: 'ScaleX', label: '横の伸縮',         unit: 'x',   eps: 0.002, neutral: 1, value: (t) => t.scale.x },
  { key: 'ScaleY', label: '縦の伸縮',         unit: 'x',   eps: 0.002, neutral: 1, value: (t) => t.scale.y },
];

// 縦横が常に同じ倍率で動く場合（拡大縮小プリセットなど）は、
// ScaleX / ScaleY に分けず1本のパラメータにまとめる。
const SCALE_UNIFORM = {
  key: 'Scale', label: '拡大縮小', unit: 'x', eps: 0.002, neutral: 1, value: (t) => t.scale.x,
};

// 横に伸びると縦が縮む（呼吸など）も、縦横が連動しているので1本にできる。
// +1 で横長、-1 で縦長。
const SCALE_OPPOSITE = {
  key: 'ScaleXY', label: '横伸縮（縦横が逆に動く）', unit: 'x', eps: 0.002, neutral: 1,
  value: (t) => t.scale.x,
};
const UNIFORM_EPS = 0.0005;

// 縦横が連動している場合は1本のパラメータにまとめる。
// 連動していないときだけ ScaleX / ScaleY に分ける（モデル側でデフォーマ2重が必要になる）。
function channelsFor(samples) {
  const merge = (ch) => CHANNELS.flatMap((c) =>
    c.key === 'ScaleX' ? [ch] : c.key === 'ScaleY' ? [] : [c]);

  if (samples.every((t) => Math.abs(t.scale.x - t.scale.y) < UNIFORM_EPS)) {
    return merge(SCALE_UNIFORM);
  }
  if (samples.every((t) => Math.abs((t.scale.x - 1) + (t.scale.y - 1)) < UNIFORM_EPS)) {
    return merge(SCALE_OPPOSITE);
  }
  return CHANNELS;
}

const OPACITY_EPS = 0.005;

// Live2D はキーフォーム間を「頂点位置の線形補間」でつなぐ。
// 回転は直線補間だと弧を描かず内側に潰れてしまうので、角度を細かく刻む必要がある。
const DEG_PER_KEYFORM = 45;

// そのパラメータに打つべきキーフォームの値を返す。
function keyformPoints(ch, min, max, start, wrapped) {
  // 正規化済み (-1〜1) は両端と中立の3点でよい
  if (ch.neutral !== undefined) return [-1, 0, 1];
  if (ch.unit === 'deg') {
    if (wrapped) return [0, 90, 180, 270, 360];
    const steps = Math.max(2, Math.ceil((max - min) / DEG_PER_KEYFORM));
    const points = [];
    for (let i = 0; i <= steps; i++) points.push(round(min + ((max - min) * i) / steps));
    return points;
  }
  // 移動・スケールは直線補間で問題ないので、両端と素の状態だけでよい
  const points = [...new Set([round(min), start, round(max)])].sort((a, b) => a - b);
  return points;
}

// ---------------------------------------------------------------- keyframes
//
// motion3.json の Segments は [t0, v0, (種別, ...)...] というフラットな数値列。
//   種別 0 = Linear   … (t, v)
//   種別 1 = Bezier   … (t1, v1, t2, v2, t3, v3)  ※制御点は区間の 1/3, 2/3 の位置
//   種別 2 = Stepped  … (t, v)  直前の値を保持して t で切り替わる
//
// サンプル列をそのままキーにすると Cubism 上で編集不能な密度になるので、
// なめらかな波はベジェで当てはめ、点滅のような矩形波はステップで表現する。

const round = (v) => Math.round(v * 10000) / 10000;

// 段数の少ない値しか取らない = 点滅系。ステップで表現する。
function encodeStepped(times, values) {
  const segments = [round(times[0]), round(values[0])];
  let count = 0;
  for (let i = 1; i < times.length; i++) {
    if (values[i] === values[i - 1]) continue;
    segments.push(2, round(times[i]), round(values[i]));
    count++;
  }
  // ループのため終端を必ず置く
  const lastT = times[times.length - 1];
  if (segments[segments.length - 2] !== round(lastT)) {
    segments.push(2, round(lastT), round(values[values.length - 1]));
    count++;
  }
  return { segments, segmentCount: count, pointCount: count + 1, keyCount: count + 1 };
}

// なめらかな波を3次ベジェで当てはめる。誤差が eps を超える区間は分割する。
function encodeBezier(times, values, eps) {
  const n = times.length;
  const slopeAt = (i) => {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    return (values[b] - values[a]) / (times[b] - times[a] || 1);
  };

  const out = [];
  const fit = (a, b, depth) => {
    const dt = times[b] - times[a];
    const v1 = values[a] + slopeAt(a) * (dt / 3);
    const v2 = values[b] - slopeAt(b) * (dt / 3);

    // 制御点の時刻が 1/3, 2/3 ちょうどなので、時刻は s に比例する
    let worst = 0;
    let worstI = -1;
    for (let i = a + 1; i < b; i++) {
      const s = (times[i] - times[a]) / dt;
      const w = 1 - s;
      const v = w * w * w * values[a] + 3 * w * w * s * v1 + 3 * w * s * s * v2 + s * s * s * values[b];
      const e = Math.abs(v - values[i]);
      if (e > worst) { worst = e; worstI = i; }
    }

    if (worst > eps && worstI > a && depth < 14) {
      fit(a, worstI, depth + 1);
      fit(worstI, b, depth + 1);
      return;
    }
    out.push({
      t1: times[a] + dt / 3, v1,
      t2: times[b] - dt / 3, v2,
      t3: times[b], v3: values[b],
    });
  };
  fit(0, n - 1, 0);

  const segments = [round(times[0]), round(values[0])];
  for (const s of out) {
    segments.push(1, round(s.t1), round(s.v1), round(s.t2), round(s.v2), round(s.t3), round(s.v3));
  }
  return {
    segments,
    segmentCount: out.length,
    pointCount: out.length * 3 + 1,
    keyCount: out.length + 1,
  };
}

// 0..360 に折り返した回転（ノコギリ波）用。折り返し地点はステップでつなぐ。
// Live2D の回転デフォーマは 0° と 360° が同じポーズなので、これで継ぎ目なく回り続ける。
function encodeWrapped(times, values, eps) {
  const runs = [[0]];
  for (let i = 1; i < times.length; i++) {
    // 正転・逆転どちらの折り返しも拾う
    if (Math.abs(values[i] - values[i - 1]) > 180) runs.push([i]);
    else runs[runs.length - 1].push(i);
  }

  const segments = [round(times[0]), round(values[0])];
  let segmentCount = 0;
  let pointCount = 1;
  let keyCount = 1;

  runs.forEach((run, ri) => {
    if (ri > 0) {
      // 折り返し: 直前の値を保ったまま、この時刻で先頭へ戻る
      segments.push(2, round(times[run[0]]), round(values[run[0]]));
      segmentCount++; pointCount++; keyCount++;
    }
    if (run.length < 2) return;
    const enc = encodeBezier(run.map((i) => times[i]), run.map((i) => values[i]), eps);
    segments.push(...enc.segments.slice(2)); // 先頭の (t, v) は既に置いてある
    segmentCount += enc.segmentCount;
    pointCount += enc.pointCount - 1;
    keyCount += enc.keyCount - 1;
  });

  return { segments, segmentCount, pointCount, keyCount };
}

function encodeCurve(times, values, eps, { wrapped = false } = {}) {
  if (wrapped) return encodeWrapped(times, values, eps);
  const levels = new Set(values.map((v) => round(v)));
  return levels.size <= 3 ? encodeStepped(times, values) : encodeBezier(times, values, eps);
}

// ---------------------------------------------------------------- IDs

// Live2D のIDは英数字にしておくのが安全なので、レイヤーには連番IDを振る。
// 元のレイヤー名との対応は手順書に載せる。
function paramId(prefix, index, channel) {
  return `${prefix}${String(index).padStart(2, '0')}_${channel}`;
}

// PSDをCubismに読み込むと、パーツIDにはレイヤー名がそのまま使われる。
// グループ階層は含まれないので末尾だけを取る。
function partId(layerName) {
  return layerName.split('/').pop();
}

// ---------------------------------------------------------------- build

export function buildMotion(state, { fps = 30, prefix = 'PSDA_L' } = {}) {
  const duration = state.loopDuration;
  const frames = Math.max(2, Math.round(duration * fps));
  const times = [];
  for (let i = 0; i <= frames; i++) times.push((i / frames) * duration);

  const curves = [];
  const paramDocs = [];
  const partDocs = [];
  const groups = [];   // パーツ単位の作業内容（手順書はこれを元に組み立てる）

  const sources = [
    // 全体モーションはモデル全体を動かすルートとして扱う
    { name: '(全体モーション)', motions: [state.global], id: `${prefix}Root`, root: true, pivot: 'doc' },
    ...state.layers
      .filter((l) => l.cfg.visible)
      .map((l, i) => ({
        name: l.def.name,
        motions: l.cfg.motions,
        id: paramId(prefix, i + 1, '').slice(0, -1), // 末尾の _ を落とす
        part: partId(l.def.name),
        pivot: l.cfg.pivot,
        baseOpacity: l.cfg.opacity,
      })),
  ];

  for (const src of sources) {
    const active = src.motions.filter((m) => m && m.preset && m.preset !== 'none');
    if (!active.length) continue;

    const samples = times.map((t) => evalMotions(src.motions, t / duration));
    const group = {
      name: src.name,
      part: src.part ?? null,
      pivot: src.pivot,
      root: !!src.root,
      presets: active.map((m) => PRESETS[m.preset]?.label ?? m.preset),
      params: [],
      opacity: null,
    };
    groups.push(group);

    // --- 変形チャンネル → Parameter
    for (const ch of channelsFor(samples)) {
      let values = samples.map(ch.value);
      let min = Math.min(...values);
      let max = Math.max(...values);
      if (max - min < ch.eps) continue;

      // 拡大率は -1〜1 (0 = 等倍) に正規化する。half が「±1のときの変化量」。
      let half = null;
      if (ch.neutral !== undefined) {
        half = Math.max(Math.abs(max - ch.neutral), Math.abs(ch.neutral - min));
        if (half < 1e-6) continue;
        values = values.map((v) => (v - ch.neutral) / half);
        min = -1;
        max = 1;
      }
      const eps = half ? ch.eps / half : ch.eps;

      // 1ループで1回転以上「回りきる」ものは、0..360 に折り返して書き出す。
      // 0〜720 のようなパラメータを作らせずに済み、キーフォームも5点で足りる。
      // 判定は往復量ではなく正味の回転量で行う（±200度の大きな揺れを誤って折り返さないため）。
      const net = Math.abs(values[values.length - 1] - values[0]);
      const wrapped = ch.unit === 'deg' && net >= 359.9;
      if (wrapped) {
        values = values.map((v) => ((v % 360) + 360) % 360);
        min = 0;
        max = 360;
      }

      const enc = encodeCurve(times, values, eps, { wrapped });
      const id = `${src.id}_${ch.key}`;
      curves.push({
        Target: 'Parameter',
        Id: id,
        FadeInTime: 0,
        FadeOutTime: 0,
        Segments: enc.segments,
        _enc: enc,
      });
      const entry = {
        id, layer: src.name, channel: ch.label, key: ch.key, unit: ch.unit,
        min: round(min), max: round(max), start: round(values[0]),
        keys: enc.keyCount, pivot: src.pivot, wrapped,
        neutral: ch.neutral, half: half === null ? null : round(half),
        keyforms: keyformPoints(ch, min, max, round(values[0]), wrapped),
      };
      paramDocs.push(entry);
      group.params.push(entry);
    }

    // --- 不透明度 → PartOpacity (パーツにそのまま効く)
    const opacity = samples.map((t) => t.userData.opacityMul * (src.baseOpacity ?? 1));
    if (Math.max(...opacity) - Math.min(...opacity) >= OPACITY_EPS) {
      const enc = encodeCurve(times, opacity, OPACITY_EPS);
      if (src.root) {
        // 全体の明滅はパーツ1つに紐付かないのでパラメータとして出す
        const id = `${src.id}_Opacity`;
        curves.push({ Target: 'Parameter', Id: id, FadeInTime: 0, FadeOutTime: 0, Segments: enc.segments, _enc: enc });
        const entry = {
          id, layer: src.name, channel: '不透明度 (0..1)', key: 'Opacity', unit: '',
          min: round(Math.min(...opacity)), max: round(Math.max(...opacity)),
          start: round(opacity[0]), keys: enc.keyCount, pivot: src.pivot,
          keyforms: [round(Math.min(...opacity)), round(Math.max(...opacity))],
        };
        paramDocs.push(entry);
        group.params.push(entry);
      } else {
        curves.push({
          Target: 'PartOpacity',
          Id: src.part,
          FadeInTime: 0,
          FadeOutTime: 0,
          Segments: enc.segments,
          _enc: enc,
        });
        const entry = {
          part: src.part, layer: src.name, keys: enc.keyCount,
          min: round(Math.min(...opacity)), max: round(Math.max(...opacity)),
        };
        partDocs.push(entry);
        group.opacity = entry;
      }
    }
  }

  const totalSegments = curves.reduce((n, c) => n + c._enc.segmentCount, 0);
  const totalPoints = curves.reduce((n, c) => n + c._enc.pointCount, 0);
  for (const c of curves) delete c._enc;

  const motion = {
    Version: 3,
    Meta: {
      Duration: round(duration),
      Fps: fps,
      Loop: true,
      AreBeziersRestricted: true,
      CurveCount: curves.length,
      TotalSegmentCount: totalSegments,
      TotalPointCount: totalPoints,
      UserDataCount: 0,
      TotalUserDataSize: 0,
    },
    Curves: curves,
    UserData: [],
  };

  // 何も出力するものが無かったグループは落とす
  const usedGroups = groups.filter((g) => g.params.length || g.opacity);

  return { motion, paramDocs, partDocs, groups: usedGroups, fps, duration };
}

// ---------------------------------------------------------------- 手順書 (HTML)
//
// Markdown だとテキストエディタで開いたときに表が崩れて読めないので、
// どこで開いても表がそのまま出る自己完結HTMLで出力する。
// 内容はパーツ(レイヤー)ごとに区切り、「そのパーツで何をすればよいか」だけを読めば済むようにする。

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// そのチャンネルに必要なデフォーマ
function deformerFor(key) {
  if (key.startsWith('Angle')) return '回転デフォーマ';
  if (key.startsWith('Scale')) return 'ワープデフォーマ';
  if (key === 'PosZ') return 'ワープデフォーマ（拡大率で代用）';
  if (key.startsWith('Pos')) return '回転デフォーマ（移動）';
  return null;
}

// 正規化された値を実際の倍率に戻す
const ratio = (param, v) => round(param.neutral + v * param.half);

// 「その値のキーで何をするか」の具体的な指示
function keyformAction(param, value) {
  const v = round(value);
  switch (param.key) {
    case 'AngleZ':
      return v === 0 ? '無変形（素の状態）'
        : param.wrapped && v === 360 ? '0度のキーと同じ形（無変形）に戻す'
        : `回転デフォーマを ${v}度 回す`;
    case 'AngleX':
      return v === 0 ? '無変形' : `X軸まわりに ${v}度 傾いた形（縦幅を縮める）`;
    case 'AngleY':
      return v === 0 ? '無変形' : `Y軸まわりに ${v}度 傾いた形（横幅を縮める）`;
    case 'PosX':
      return v === 0 ? '無変形' : `${v > 0 ? '右' : '左'}へ ${Math.abs(v)}px 移動`;
    case 'PosY':
      return v === 0 ? '無変形' : `${v > 0 ? '上' : '下'}へ ${Math.abs(v)}px 移動`;
    case 'PosZ':
      return v === 0 ? '無変形' : `奥行き ${v}px 相当（${v > 0 ? '手前=少し拡大' : '奥=少し縮小'}）`;
    // 拡大率は -1〜1 に正規化してあるので、実際の倍率に戻して指示する
    case 'Scale':
      return v === 0 ? '無変形（等倍）' : `縦横まとめて ${ratio(param, v)}倍`;
    case 'ScaleXY':
      // 縦は横の逆向きに同じだけ動く
      return v === 0 ? '無変形（等倍）'
        : `横幅を ${ratio(param, v)}倍 ／ 縦幅を ${ratio(param, -v)}倍`;
    case 'ScaleX':
      return v === 0 ? '無変形（等倍）' : `横幅を ${ratio(param, v)}倍`;
    case 'ScaleY':
      return v === 0 ? '無変形（等倍）' : `縦幅を ${ratio(param, v)}倍`;
    case 'Opacity':
      return `不透明度 ${v}`;
    default:
      return `値 ${v} の状態`;
  }
}

// 1周回りきる回転はリピートをONにする。0度と360度が同じ点として扱われ、
// 何周してもパラメータが端で詰まらない。それ以外はOFF。
const repeatLabel = (p) => (p.wrapped ? 'ON' : 'OFF');

function paramTable(params) {
  const rows = params.map((p) => `
      <tr>
        <td><code>${esc(p.id)}</code></td>
        <td>${esc(p.channel)}</td>
        <td class="num">${p.min}</td>
        <td class="num">${p.start}</td>
        <td class="num">${p.max}</td>
        <td class="${p.wrapped ? 'on' : 'off'}">${repeatLabel(p)}</td>
      </tr>`).join('');
  return `
    <table>
      <thead><tr>
        <th>パラメータID</th><th>意味</th><th>最小値</th><th>デフォルト値</th><th>最大値</th><th>リピート</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function keyformTable(param) {
  const rows = param.keyforms.map((v) => `
      <tr><td class="num">${round(v)}</td><td>${esc(keyformAction(param, v))}</td></tr>`).join('');
  return `
    <table class="kf">
      <thead><tr><th>パラメータ値</th><th>そのキーで作る形</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function groupSection(group, index) {
  const title = group.root ? '全体モーション（モデル全体）' : group.name;
  const parts = [];

  parts.push(`<section class="part">`);
  parts.push(`<h2><span class="n">${index}</span>${esc(title)}</h2>`);

  const facts = [];
  if (group.part) facts.push(`パーツID: <code>${esc(group.part)}</code>`);
  facts.push(`動き: ${esc(group.presets.join(' + '))}`);
  if (group.params.some((p) => p.key.startsWith('Angle') || p.key.startsWith('Scale'))) {
    facts.push(`変形の中心: <b>${esc(pivotLabel(group.pivot))}</b>`);
  }
  parts.push(`<p class="facts">${facts.join(' ／ ')}</p>`);

  if (!group.params.length) {
    parts.push('<p class="ok">✔ このパーツは不透明度だけなので、<b>モデル側の作業は不要</b>です。' +
      `<code>.motion3.json</code> がパーツ <code>${esc(group.part)}</code> に直接効きます。</p>`);
    parts.push('</section>');
    return parts.join('\n');
  }

  const deformers = [...new Set(group.params.map((p) => deformerFor(p.key)).filter(Boolean))];

  parts.push('<h3>このパーツでやること</h3>');
  parts.push('<ol class="steps">');
  if (!group.root) {
    parts.push(`<li>アートメッシュ <code>${esc(group.part ?? group.name)}</code> を選択します。</li>`);
  } else {
    parts.push('<li>モデル全体（ルートのデフォーマ、なければ全パーツを含むデフォーマ）を選択します。</li>');
  }
  // 縦横が独立して動くパーツは、ワープデフォーマ自体を2重にする必要がある
  const splitScale = group.params.some((p) => p.key === 'ScaleX')
    && group.params.some((p) => p.key === 'ScaleY');
  const list = splitScale
    ? deformers.map((d) => (d === 'ワープデフォーマ' ? 'ワープデフォーマ2つ（縦用・横用）' : d))
    : deformers;

  parts.push(`<li><b>${list.join(' と ')}</b> を作成し、` +
    (list.length > 1
      ? '<b>入れ子</b>にして対象を包みます（1つのデフォーマには1つのパラメータだけ割り当てます）。'
      : '対象を包みます。') +
    (group.params.some((p) => p.key.startsWith('Angle'))
      ? ` 回転デフォーマの中心は <b>${esc(pivotLabel(group.pivot))}</b> に置いてください。`
      : '') + '</li>');

  if (splitScale) {
    parts.push('<li>横と縦が独立して伸縮するので、外側のワープに <code>ScaleY</code>、' +
      '内側のワープに <code>ScaleX</code> を割り当てます。' +
      '<b>1つのデフォーマに2つのパラメータを割り当てないでください</b>' +
      '（キーフォームが組み合わせ分必要になり、破綻しやすくなります）。</li>');
  }
  parts.push('<li>下の表のパラメータを新規作成します（ID・最小値・デフォルト値・最大値をそのまま入力）。' +
    (group.params.some((p) => p.wrapped)
      ? ' <b>リピートがONのものは、パラメータ設定で「リピート」にチェックを入れてください。</b>'
      : '') + '</li>');
  parts.push(`<li>各パラメータについて、「打つキーフォーム」の値でキーを追加し、書いてある形を作ります。</li>`);
  if (group.opacity) {
    parts.push('<li>不透明度は自動です（作業不要）。</li>');
  }
  parts.push('</ol>');

  parts.push('<h3>作成するパラメータ</h3>');
  parts.push(paramTable(group.params));

  parts.push('<h3>打つキーフォーム</h3>');
  for (const p of group.params) {
    parts.push(`<div class="kfblock"><p class="kfhead"><code>${esc(p.id)}</code> — ${esc(p.channel)}` +
      (p.wrapped ? ' <span class="tag">1周回るタイプ</span>' : '') + '</p>');
    parts.push(keyformTable(p));
    parts.push('</div>');
  }

  if (group.opacity) {
    parts.push(`<p class="ok">✔ 不透明度（${group.opacity.min} 〜 ${group.opacity.max}）は ` +
      `パーツ <code>${esc(group.opacity.part)}</code> に直接効くので、<b>設定不要</b>です。</p>`);
  }

  parts.push('</section>');
  return parts.join('\n');
}

export function buildGuideHtml(state, built) {
  const { groups, paramDocs, partDocs, fps, duration } = built;
  const doc = state.doc;

  const sections = groups.map((g, i) => groupSection(g, i + 1)).join('\n');
  const allRows = paramDocs.map((p) => `
      <tr>
        <td><code>${esc(p.id)}</code></td><td>${esc(p.layer)}</td><td>${esc(p.channel)}</td>
        <td class="num">${p.min}</td><td class="num">${p.start}</td><td class="num">${p.max}</td>
        <td class="${p.wrapped ? 'on' : 'off'}">${repeatLabel(p)}</td>
        <td>${p.keyforms.map(round).join(' / ')}</td>
      </tr>`).join('');

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>${esc(doc.name)} — Live2D 取り込み手順</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: "Segoe UI", "Yu Gothic UI", Meiryo, system-ui, sans-serif;
         line-height: 1.7; margin: 0 auto; padding: 32px 24px 80px; max-width: 900px; }
  h1 { font-size: 22px; border-bottom: 2px solid currentColor; padding-bottom: 8px; }
  h2 { font-size: 18px; margin: 0 0 4px; }
  h3 { font-size: 14px; margin: 20px 0 6px; opacity: .75; letter-spacing: .05em; }
  code { background: rgba(128,128,128,.18); padding: 1px 5px; border-radius: 4px;
         font-family: Consolas, monospace; font-size: .92em; }
  table { border-collapse: collapse; width: 100%; margin: 6px 0 14px; font-size: 13px; }
  th, td { border: 1px solid rgba(128,128,128,.45); padding: 5px 9px; text-align: left; vertical-align: top; }
  th { background: rgba(128,128,128,.16); white-space: nowrap; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.on { font-weight: 700; color: #2e9e5b; }
  td.off { opacity: .55; }
  table.kf { max-width: 560px; }
  .part { border: 1px solid rgba(128,128,128,.45); border-radius: 10px; padding: 16px 20px; margin: 20px 0; }
  .part h2 .n { display: inline-block; min-width: 26px; height: 26px; line-height: 26px; text-align: center;
                border-radius: 50%; background: rgba(128,128,128,.25); margin-right: 10px; font-size: 14px; }
  .facts { margin: 4px 0 0; font-size: 13px; opacity: .8; }
  .steps li { margin-bottom: 4px; }
  .kfblock { margin-bottom: 10px; }
  .kfhead { margin: 10px 0 2px; font-size: 13px; }
  .tag { background: rgba(128,128,128,.25); border-radius: 4px; padding: 1px 6px; font-size: 11px; }
  .ok { background: rgba(90,170,120,.18); border-left: 3px solid rgba(90,170,120,.9);
        padding: 8px 12px; border-radius: 0 6px 6px 0; font-size: 13px; }
  .note { background: rgba(150,150,150,.14); border-left: 3px solid rgba(140,140,140,.8);
          padding: 8px 12px; border-radius: 0 6px 6px 0; font-size: 13px; margin: 10px 0; }
  .meta { font-size: 13px; opacity: .8; }
  @media print { .part { break-inside: avoid; } }
</style>
</head>
<body>
<h1>${esc(doc.name)} — Live2D 取り込み手順</h1>
<p class="meta">
  元PSD: <b>${esc(doc.name)}</b>（${doc.width}×${doc.height}px / ${doc.layers.length}レイヤー）<br>
  ループ長: <b>${duration}秒</b> / ${fps}fps ・ カーブ数 ${built.motion.Meta.CurveCount}
  （パラメータ ${paramDocs.length} / パーツ不透明度 ${partDocs.length}）
</p>

<div class="note">
  <b>先に読んでください。</b>
  <code>.motion3.json</code> が持っているのは<b>パラメータ値の時間変化だけ</b>です。
  「そのパラメータ値のときにどんな形か」はモデル側のキーフォームが持つので、両方そろって初めて絵が動きます。
  以下はパーツごとに分けてあるので、<b>1パーツずつ上から順に</b>進めてください。
</div>

<h3>全体の流れ</h3>
<ol>
  <li>Cubism Editor で元のPSDを読み込み、レイヤーからアートメッシュを作る。</li>
  <li>下の「パーツごとの作業」を1つずつ実施する。</li>
  <li>モデルを保存し、Cubism Animator で <code>.motion3.json</code> を読み込む
      （ファイル → 読み込み → モーション）。</li>
  <li>シーンをループ再生にすると、ツール上と同じループになります。</li>
</ol>

<h3>パーツごとの作業</h3>
${sections}

<h3>全パラメータ一覧</h3>
<table>
  <thead><tr>
    <th>パラメータID</th><th>対象</th><th>意味</th>
    <th>最小値</th><th>デフォルト値</th><th>最大値</th><th>リピート</th><th>打つキーフォーム</th>
  </tr></thead>
  <tbody>${allRows}</tbody>
</table>

<div class="note">
  <b>複数のパラメータを1つのパーツに効かせるとき。</b>
  Cubism では1つのデフォーマに2つのパラメータを割り当てると、キーフォームが
  <b>組み合わせの数だけ</b>必要になります（3キー × 3キー = 9個）。
  そうではなく <b>デフォーマを入れ子にして、1デフォーマ = 1パラメータ</b> にしてください。
  たとえば「回転 + 伸縮」なら、外側に回転デフォーマ、内側にワープデフォーマを置き、
  それぞれに1つずつパラメータを割り当てます。変形が掛け算で合成され、キーフォームは足し算の数で済みます。
  （Cubism 4.2以降のブレンドシェイプでも同じことができますが、入れ子のほうがどのバージョンでも確実です）
</div>

<div class="note">
  <b>回転が途中で潰れる場合はキー不足です。</b>
  Live2D はキーフォームの間を頂点位置の直線補間でつなぐため、0度と180度の2キーだけだと弧を描かず中心へ潰れます。
  この手順書は回転を ${DEG_PER_KEYFORM}度以内の刻みで出しています。<br>
  <b>「1周回るタイプ」</b>（最小0 / 最大360）は、0度と360度が同じポーズになるノコギリ波として書き出しています。
  360度のキーは0度と同じ形（無変形）にし、<b>パラメータのリピートをONに</b>してください。
  0度と360度が同じ点として扱われるので、何周でも端で詰まらずに回り続けます。
  それ以外のパラメータはリピートOFFのままにしてください（往復する動きが端で飛んでしまうため）。
</div>

<div class="note">
  パラメータの単位は、移動 = <b>px（PSD原寸基準）</b>、回転 = <b>度</b>。表の最小/最大どおりに作れば
  キーフォームの変形量がそのまま実寸になります。<br>
  伸縮系だけは <b>-1〜1（0が等倍）</b> に正規化してあります。拡大率をそのままパラメータ値にすると
  「0.59〜1.41 / デフォルト1」のような扱いにくい範囲になるためです。
  実際の倍率は各キーフォームの指示文に書いてあります。<br>
  Cubism のモデル編集ファイル（<code>.cmo3</code>）とアニメーション編集ファイル（<code>.can3</code>）は
  非公開フォーマットのため生成できません。公開仕様の <code>.motion3.json</code> を出力しています。
</div>
</body>
</html>`;
}

// 表計算で開きたい人向け。Excelで文字化けしないよう BOM を付ける。
export function buildParamsCsv(built) {
  const head = ['パラメータID', '対象', '意味', '最小値', 'デフォルト値', '最大値',
    'リピート', '変形の中心', '打つキーフォーム'];
  const cell = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const rows = built.paramDocs.map((p) => [
    p.id, p.layer, p.channel, p.min, p.start, p.max,
    repeatLabel(p), pivotLabel(p.pivot), p.keyforms.map(round).join(' / '),
  ].map(cell).join(','));
  return '﻿' + [head.map(cell).join(','), ...rows].join('\r\n');
}

function pivotLabel(pivot) {
  return {
    center: 'レイヤー中央', doc: '画像の中心軸', bottom: 'レイヤー下端',
    top: 'レイヤー上端', left: 'レイヤー左端', right: 'レイヤー右端',
  }[pivot] ?? '-';
}

// ---------------------------------------------------------------- download

// 書き出すファイル一式を組み立てて返す。
export function buildFiles(state, { fps = 30 } = {}) {
  if (!state.doc) throw new Error('先にPSDを読み込んでください');
  const built = buildMotion(state, { fps });
  if (!built.motion.Curves.length) throw new Error('書き出せるアニメーションがありません（モーションを設定してください）');

  // ファイル名はASCIIにしておく（日本語名だと環境によっては文字化けして見つけにくい）
  const base = state.doc.name.replace(/\.psd$/i, '');
  return {
    built,
    files: [
      { name: `${base}.motion3.json`, text: JSON.stringify(built.motion, null, 2), type: 'application/json' },
      { name: `${base}_live2d_setup.html`, text: buildGuideHtml(state, built), type: 'text/html;charset=utf-8' },
      { name: `${base}_live2d_params.csv`, text: buildParamsCsv(built), type: 'text/csv;charset=utf-8' },
    ],
  };
}

export function download(file) {
  const url = URL.createObjectURL(new Blob([file.text], { type: file.type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// 1クリックで2ファイルを落とすとブラウザに「複数ファイルの自動ダウンロード」として
// ブロックされることがあるため、間隔を空けて順に保存する。
// それでも止められた場合に備えて、呼び出し側で手動保存リンクを出しておくこと。
export async function exportLive2d(state, { fps = 30 } = {}) {
  const { built, files } = buildFiles(state, { fps });
  download(files[0]);
  await new Promise((r) => setTimeout(r, 800));
  download(files[1]);
  return { built, files };
}
