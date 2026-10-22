import { readPsd } from 'ag-psd';

// PSD を読み込み、描画可能なレイヤーのフラットな配列にする。
// グループ(フォルダ)は再帰的に展開し、名前を "親/子" 形式で連結する。
export async function loadPsd(file) {
  const buffer = await file.arrayBuffer();
  const psd = readPsd(buffer, {
    skipCompositeImageData: true,
    skipThumbnail: true,
    useImageData: false,
  });

  const layers = [];
  walk(psd.children || [], '', layers);

  // PSD のレイヤー配列は「下から上」の順。奥行きもその順で積む。
  return {
    name: file.name,
    width: psd.width,
    height: psd.height,
    layers,
  };
}

function walk(children, prefix, out) {
  for (const layer of children) {
    const name = prefix ? `${prefix}/${layer.name || '(無名)'}` : (layer.name || '(無名)');
    if (layer.children) {
      walk(layer.children, name, out);
      continue;
    }
    const canvas = layer.canvas;
    if (!canvas || !canvas.width || !canvas.height) continue;

    out.push({
      name,
      canvas,
      left: layer.left ?? 0,
      top: layer.top ?? 0,
      width: canvas.width,
      height: canvas.height,
      opacity: layer.opacity ?? 1,
      hiddenInPsd: !!layer.hidden,
    });
  }
}
