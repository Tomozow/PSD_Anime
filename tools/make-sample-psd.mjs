// 動作確認用のサンプルPSDを public/sample.psd に生成する。
//   node tools/make-sample-psd.mjs
import { writePsd } from 'ag-psd';
import { writeFileSync, mkdirSync } from 'node:fs';

const W = 800, H = 600;

function rect(w, h, [r, g, b], round = 0) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let a = 255;
      if (round) {
        const dx = Math.max(round - x, x - (w - 1 - round), 0);
        const dy = Math.max(round - y, y - (h - 1 - round), 0);
        if (Math.hypot(dx, dy) > round) a = 0;
      }
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
    }
  }
  return { width: w, height: h, data };
}

const psd = {
  width: W,
  height: H,
  children: [
    { name: '背景', left: 0, top: 0, imageData: rect(W, H, [40, 60, 110]) },
    { name: '中景', left: 120, top: 200, imageData: rect(560, 300, [70, 130, 180], 40) },
    { name: 'キャラ', left: 300, top: 150, imageData: rect(200, 320, [235, 200, 160], 90) },
    { name: '前景パーツ', left: 520, top: 380, imageData: rect(180, 180, [240, 120, 90], 90) },
  ],
};

mkdirSync('public', { recursive: true });
writeFileSync('public/sample.psd', Buffer.from(writePsd(psd, { generateThumbnail: false })));
console.log('wrote public/sample.psd');
