import 'server-only';
// podpaket „node" nosi tipove; glavni ulaz ih u TS-u s moduleResolution bundler ne izlaže
import bwipjs from 'bwip-js/node';

/**
 * Barkodovi za PDF kao PNG data URL (pdfmake ne čita vanjske datoteke):
 * HUB-3 (PDF417) za plaćanje i QR za provjeru fiskaliziranog računa — isti
 * parametri kao rute /api/prodaja/racuni/[id]/hub3 i /fiskal-qr.
 */
async function png(opts: Parameters<typeof bwipjs.toBuffer>[0]): Promise<string | null> {
  try {
    const buf = await bwipjs.toBuffer(opts);
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch (e) {
    console.error('[pdf/barcode]', e);
    return null;
  }
}

/** HUB-3 2D barkod (PDF417) iz teksta `hub3Text(...)`. */
export function hub3Png(text: string) {
  // columns/eclevel su opcije simbologije PDF417 koje tipovi bwip-js ne navode
  return png({ bcid: 'pdf417', text, columns: 9, eclevel: 4, scale: 3 } as Parameters<typeof bwipjs.toBuffer>[0]);
}

/** QR kod (npr. poveznica za provjeru računa na porezna.gov.hr). */
export function qrPng(text: string) {
  return png({ bcid: 'qrcode', text, scale: 4, eclevel: 'M' } as Parameters<typeof bwipjs.toBuffer>[0]);
}
