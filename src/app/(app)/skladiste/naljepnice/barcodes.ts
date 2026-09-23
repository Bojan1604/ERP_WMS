import 'server-only';
// podpaket „node" nosi tipove; glavni ulaz ih u TS-u s moduleResolution bundler ne izlaže
import bwipjs from 'bwip-js/node';

/** Code 128 serijskog broja kao SVG koji se širinom rasteže na naljepnicu (omjeri crta ostaju isti). */
export function code128Svg(text: string): string | null {
  try {
    const svg = bwipjs.toSVG({ bcid: 'code128', text, height: 10, includetext: false });
    return svg.replace('<svg ', '<svg preserveAspectRatio="none" ');
  } catch {
    return null; // znakovi koje Code 128 ne može kodirati — naljepnica tada ima samo tekst
  }
}

/** QR kod (poveznica na karticu uređaja). */
export function qrSvg(text: string): string | null {
  try {
    return bwipjs.toSVG({ bcid: 'qrcode', text, eclevel: 'M' } as Parameters<typeof bwipjs.toSVG>[0]);
  } catch {
    return null;
  }
}
