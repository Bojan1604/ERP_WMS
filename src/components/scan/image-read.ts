'use client';

/*
 * Čitanje naljepnica s fotografije (skener → Galerija / Slikaj):
 *   • barkodovi: @zxing/browser nad slikom — cijela slika, zakrenuta i u mreži
 *     izrezaka (sitni barkodovi na velikoj fotografiji), uz ugrađeni
 *     BarcodeDetector preglednika kad postoji (čita više kodova odjednom)
 *   • OCR (tesseract.js) za naljepnice bez barkoda — učitava se tek na zahtjev
 *     (dinamički import), jer je velik i jezične podatke preuzima s interneta
 */

import { NATIVE_FORMATS } from './core';

interface DetectorLike {
  detect(src: ImageBitmapSource): Promise<Array<{ rawValue: string }>>;
}

async function loadImage(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('Slika se ne može učitati.'));
      img.src = url;
    });
    return img;
  } finally {
    // slika je već dekodirana u elementu
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

const pause = () => new Promise((r) => setTimeout(r, 0));

/** Svi barkodovi / QR kodovi sa slike (prazno ako ništa). */
export async function readImageBarcodes(file: Blob): Promise<string[]> {
  const found = new Set<string>();
  const img = await loadImage(file);

  const Native = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => DetectorLike }).BarcodeDetector;
  if (Native) {
    try {
      for (const r of await new Native({ formats: [...NATIVE_FORMATS] }).detect(img)) if (r.rawValue.trim()) found.add(r.rawValue.trim());
    } catch {
      /* preglednik nema čitač za sliku — nastavlja ZXing */
    }
  }

  const [{ BrowserMultiFormatReader }, { DecodeHintType }] = await Promise.all([import('@zxing/browser'), import('@zxing/library')]);
  const hints = new Map();
  hints.set(DecodeHintType.TRY_HARDER, true);
  const reader = new BrowserMultiFormatReader(hints);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const tryCrop = (sx: number, sy: number, sw: number, sh: number, scale: number, rotate: boolean) => {
    const c = document.createElement('canvas');
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    c.width = rotate ? h : w;
    c.height = rotate ? w : h;
    const g = c.getContext('2d');
    if (!g) return;
    if (rotate) {
      g.translate(c.width / 2, c.height / 2);
      g.rotate(Math.PI / 2);
      g.drawImage(img, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
    } else g.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
    try {
      const t = reader.decodeFromCanvas(c).getText().trim();
      if (t) found.add(t);
    } catch {
      /* na ovom izrezu nema koda */
    }
  };

  // cijela slika (smanjena i u izvornoj veličini, uspravno i zakrenuto)
  for (const scale of [Math.min(1, 1400 / Math.max(W, H)), 1]) for (const rot of [false, true]) tryCrop(0, 0, W, H, scale, rot);
  await pause();
  // mreža izrezaka s preklapanjem — naljepnica s više barkodova ili sitan barkod
  for (const n of [2, 3]) {
    const tw = W / n;
    const th = H / n;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const sx = Math.max(0, i * tw - tw * 0.2);
        const sy = Math.max(0, j * th - th * 0.2);
        const sw = Math.min(W - sx, tw * 1.4);
        const sh = Math.min(H - sy, th * 1.4);
        tryCrop(sx, sy, sw, sh, Math.min(2, 1600 / Math.max(sw, sh)), false);
      }
    await pause();
  }
  return [...found];
}

/** OCR nije dostupan (npr. bez interneta) — poruka za korisnika. */
export class OcrUnavailableError extends Error {}

/**
 * Tekst s naljepnice (OCR). tesseract.js se učitava tek sada; jezični podaci se
 * preuzimaju s interneta pri prvoj upotrebi — bez veze baca OcrUnavailableError.
 */
export async function ocrImageText(file: Blob, onProgress?: (pct: number) => void): Promise<string> {
  let T: typeof import('tesseract.js');
  try {
    T = await import('tesseract.js');
  } catch {
    throw new OcrUnavailableError('Prepoznavanje teksta se ne može učitati — provjerite internetsku vezu.');
  }
  let worker: Awaited<ReturnType<typeof T.createWorker>> | null = null;
  try {
    worker = await T.createWorker('eng', 1, {
      logger: (m: { status: string; progress: number }) => {
        if (m.status === 'recognizing text') onProgress?.(Math.round(m.progress * 100));
      },
    });
    await worker.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-./:' });
    // crno-bijelo s pojačanim kontrastom pomaže sitnom tisku
    const img = await loadImage(file);
    const c = document.createElement('canvas');
    const scale = Math.min(2, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    const g = c.getContext('2d');
    if (!g) throw new Error('Slika se ne može obraditi.');
    g.drawImage(img, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height);
    const px = d.data;
    for (let i = 0; i < px.length; i += 4) {
      const y = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      const v = y < 128 ? Math.max(0, y - 40) : Math.min(255, y + 40);
      px[i] = px[i + 1] = px[i + 2] = v;
    }
    g.putImageData(d, 0, 0);
    const { data } = await worker.recognize(c);
    return data.text ?? '';
  } catch (e) {
    if (e instanceof OcrUnavailableError) throw e;
    // tesseract preuzima jezgru i jezične podatke s CDN-a — bez veze to ne uspijeva
    if (!navigator.onLine || /fetch|network|load|import/i.test(String((e as Error)?.message ?? e))) {
      throw new OcrUnavailableError('Prepoznavanje teksta traži internetsku vezu (preuzimanje jezičnih podataka). Upišite serijski broj ručno.');
    }
    throw e;
  } finally {
    await worker?.terminate().catch(() => {});
  }
}
