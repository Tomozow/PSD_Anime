// ループアニメーションのプリセット定義。
// すべて周期 1.0 (= ループ長) の関数で表現するため、必ず継ぎ目なくループする。
//
// apply(target, u, amp, cycles) の u は 0..1 に正規化されたループ位相。
// target は three.js の Object3D。基準姿勢は呼び出し側でリセット済み。
//
// 1レイヤーに複数のエフェクトを重ねられるよう、すべて「加算 / 乗算」で書くこと。
// (rotation は +=、scale は *=、opacityMul は *=)

const TAU = Math.PI * 2;

// --- ループを壊さないランダム ---------------------------------------------
// 整数倍音の正弦波だけを合成するので、周期は必ず 1.0 のまま。
// seed を変えると波形が変わり、rnd (0..1) で「どれだけ不規則にするか」を決める。

function hash(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

// 戻り値はおおよそ -1..1
export function loopNoise(u, seed, harmonics = 6) {
  let v = 0;
  let norm = 0;
  for (let k = 1; k <= harmonics; k++) {
    const weight = 1 / k;
    v += Math.sin(TAU * k * u + hash(seed * 31 + k) * TAU) * weight;
    norm += weight;
  }
  return v / norm;
}

const mix = (a, b, t) => a + (b - a) * t;

// サイン波にノイズを混ぜた基本波形 (-1..1)
function wave(u, cycles, rnd, seed) {
  const s = Math.sin(TAU * u * cycles);
  return rnd > 0 ? mix(s, loopNoise(u * cycles, seed, 6), rnd) : s;
}

export const PRESETS = {
  none: {
    label: 'なし',
    apply() {},
  },
  spinY: {
    label: 'Y軸まわり回転 (3D)',
    // cycles は「1ループ中に何回転するか」
    apply(t, u, amp, cycles) {
      t.rotation.y += TAU * u * cycles;
    },
  },
  spinX: {
    label: 'X軸まわり回転 (3D)',
    apply(t, u, amp, cycles) {
      t.rotation.x += TAU * u * cycles;
    },
  },
  spinZ: {
    label: 'Z軸まわり回転 (平面回転)',
    apply(t, u, amp, cycles) {
      t.rotation.z += TAU * u * cycles;
    },
  },
  tilt3d: {
    label: '3Dゆらぎ (首振り)',
    apply(t, u, amp, cycles, rnd, seed) {
      t.rotation.y += amp * wave(u, cycles, rnd, seed);
      t.rotation.x += amp * 0.5 * wave(u + 0.25, cycles, rnd, seed + 7);
    },
  },
  swing: {
    label: '振り子 (Z揺れ)',
    apply(t, u, amp, cycles, rnd, seed) {
      t.rotation.z += amp * wave(u, cycles, rnd, seed);
    },
  },
  bob: {
    label: '上下ふわふわ',
    apply(t, u, amp, cycles, rnd, seed) {
      t.position.y += amp * wave(u, cycles, rnd, seed);
    },
  },
  sway: {
    label: '左右スライド',
    apply(t, u, amp, cycles, rnd, seed) {
      t.position.x += amp * wave(u, cycles, rnd, seed);
    },
  },
  orbit: {
    label: '円運動',
    apply(t, u, amp, cycles) {
      const w = TAU * u * cycles;
      t.position.x += amp * Math.cos(w);
      t.position.y += amp * Math.sin(w);
    },
  },
  pulse: {
    label: '拡大縮小',
    apply(t, u, amp, cycles) {
      t.scale.multiplyScalar(1 + amp * 0.5 * Math.sin(TAU * u * cycles));
    },
  },
  breathe: {
    label: '横伸縮 (呼吸)',
    apply(t, u, amp, cycles) {
      const w = TAU * u * cycles;
      t.scale.x *= 1 + amp * 0.3 * Math.sin(w);
      t.scale.y *= 1 - amp * 0.3 * Math.sin(w);
    },
  },
  depth: {
    label: '奥行き往復',
    apply(t, u, amp, cycles) {
      t.position.z += amp * Math.sin(TAU * u * cycles);
    },
  },
  blink: {
    label: '点滅 (オン/オフ)',
    // 矩形波。amp=1 で完全に消える。
    // ランダム度を上げると、点いている長さ・消えている長さが不規則になる。
    apply(t, u, amp, cycles, rnd, seed) {
      const threshold = 0.5 + rnd * 0.45 * loopNoise(u, seed, 5);
      const on = (u * cycles) % 1 < threshold;
      if (!on) t.userData.opacityMul *= Math.max(0, 1 - amp);
    },
  },
  fade: {
    label: '明滅 (なめらか)',
    apply(t, u, amp, cycles, rnd, seed) {
      // k: 0(明るい) .. 1(暗い)
      const k = 0.5 - 0.5 * wave(u + 0.25, cycles, rnd, seed);
      t.userData.opacityMul *= 1 - Math.min(1, amp) * k;
    },
  },
  flicker: {
    label: 'ちらつき (不規則)',
    // 常に不規則。ランダム度でちらつきの細かさ (倍音の多さ) が増す。
    apply(t, u, amp, cycles, rnd, seed) {
      const n = loopNoise(u * cycles, seed, 3 + Math.round(rnd * 9));
      t.userData.opacityMul *= 1 - Math.min(1, amp) * 0.5 * (0.5 + 0.5 * n);
    },
  },
};

export const PRESET_KEYS = Object.keys(PRESETS);
