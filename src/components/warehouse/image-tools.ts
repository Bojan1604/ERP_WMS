'use client';

import { ATTACHMENT_MAX_BYTES, fitWithin, IMAGE_MAX_SIDE } from '@/domain/attachments';
import { NATIVE_FORMATS } from '@/components/scan/core';

/**
 * Priprema slike u pregledniku: smanjivanje na najviše 1600 px (JPEG) prije
 * slanja — slika s mobitela ima 3–8 MB, nakon smanjivanja ~200–400 kB — i
 * čitanje barkoda sa slike naljepnice radi uparivanja s uređajem.
 */

async function decode(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  try {
    // imageOrientation: slika s mobitela ostaje uspravna (EXIF)
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
    } catch {
      URL.revokeObjectURL(url);
      throw new Error(`Slika „${(file as File).name ?? ''}" se ne može pročitati.`);
    }
  }
}

const baseName = (name: string) => name.replace(/\.[a-z0-9]{1,5}$/i, '') || 'slika';

/**
 * Slika → JPEG najviše `maxSide` px (zadano 1600); PDF ostaje kakav jest. Baca grešku
 * ako je rezultat veći od `maxBytes` (zadano 2 MB; prilozi uz dokumente 10 MB).
 */
export async function prepareUpload(file: File, opts: { maxBytes?: number; maxSide?: number } = {}): Promise<File> {
  const maxBytes = opts.maxBytes ?? ATTACHMENT_MAX_BYTES;
  const mb = `${Math.round(maxBytes / 1024 / 1024)} MB`;
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    if (file.size > maxBytes) throw new Error(`PDF „${file.name}" je veći od ${mb}.`);
    return file;
  }
  const img = await decode(file);
  try {
    const { width, height } = fitWithin(img.width, img.height, opts.maxSide ?? IMAGE_MAX_SIDE);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Preglednik ne može obraditi sliku.');
    ctx.fillStyle = '#fff'; // prozirni PNG → bijela pozadina u JPEG-u
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img.source, 0, 0, width, height);
    for (const q of [0.85, 0.7, 0.55]) {
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', q));
      if (blob && blob.size <= maxBytes) return new File([blob], `${baseName(file.name)}.jpg`, { type: 'image/jpeg' });
    }
    throw new Error(`Slika „${file.name}" je i nakon smanjivanja veća od ${mb}.`);
  } finally {
    img.close();
  }
}

interface DetectorLike {
  detect(src: ImageBitmapSource): Promise<Array<{ rawValue: string }>>;
}

/** Kodovi pročitani sa slike (ugrađeni BarcodeDetector ili zxing); prazno ako ništa. */
export async function readCodes(file: Blob): Promise<string[]> {
  if (file.type === 'application/pdf') return [];
  try {
    const Native = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => DetectorLike }).BarcodeDetector;
    if (Native) {
      const bmp = await createImageBitmap(file);
      try {
        const found = await new Native({ formats: [...NATIVE_FORMATS] }).detect(bmp);
        return [...new Set(found.map((f) => f.rawValue.trim()).filter(Boolean))];
      } finally {
        bmp.close();
      }
    }
    const { BrowserMultiFormatReader } = await import('@zxing/browser');
    const url = URL.createObjectURL(file);
    try {
      const r = await new BrowserMultiFormatReader().decodeFromImageUrl(url);
      const text = r.getText().trim();
      return text ? [text] : [];
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return [];
  }
}

/** Obični objekt + datoteke → FormData za server akciju (`json` + parovi `photo`/`photoFor`). */
export function photoForm(data: Record<string, unknown>, photos: Array<{ file: File; target: string | null }>): FormData {
  const fd = new FormData();
  fd.set('json', JSON.stringify(data));
  for (const p of photos) {
    fd.append('photo', p.file, p.file.name);
    fd.append('photoFor', p.target ?? '');
  }
  return fd;
}
