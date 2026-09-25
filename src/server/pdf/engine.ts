import 'server-only';
import path from 'node:path';
import pdfmake from 'pdfmake';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';

/**
 * pdfmake na poslužitelju. Font je Roboto iz paketa pdfmake (TTF s hrvatskim
 * znakovima čćžšđ i €); „bold" je Roboto Medium. Datoteke se čitaju s diska
 * (node_modules), pa pdfmake mora biti u `serverExternalPackages`.
 * Vanjski URL-ovi i lokalne datoteke u dokumentu su zabranjeni — slike se daju
 * kao data URL (logo firme, barkod).
 */
let ready = false;

function setup() {
  if (ready) return;
  const dir = path.join(process.cwd(), 'node_modules', 'pdfmake', 'fonts', 'Roboto');
  pdfmake.setFonts({
    Roboto: {
      normal: path.join(dir, 'Roboto-Regular.ttf'),
      bold: path.join(dir, 'Roboto-Medium.ttf'),
      italics: path.join(dir, 'Roboto-Italic.ttf'),
      bolditalics: path.join(dir, 'Roboto-MediumItalic.ttf'),
    },
  });
  // samo fontovi iz gornje mape; slike i ostalo isključivo kao data URL
  pdfmake.setLocalAccessPolicy((p: string) => path.resolve(p).startsWith(dir));
  pdfmake.setUrlAccessPolicy(() => false);
  ready = true;
}

/** Zadani stil svih dokumenata (A4, Roboto 9 pt). */
export const BASE_DOC: Partial<TDocumentDefinitions> = {
  pageSize: 'A4',
  pageMargins: [36, 40, 36, 48],
  defaultStyle: { font: 'Roboto', fontSize: 9, lineHeight: 1.15 },
  info: { producer: 'ERP/WMS', creator: 'ERP/WMS' },
};

/** Definicija dokumenta → PDF (Buffer). */
export async function renderPdf(doc: TDocumentDefinitions): Promise<Buffer> {
  setup();
  const def: TDocumentDefinitions = {
    ...BASE_DOC,
    ...doc,
    defaultStyle: { ...BASE_DOC.defaultStyle, ...(doc.defaultStyle ?? {}) },
    info: { ...BASE_DOC.info, ...(doc.info ?? {}) },
  };
  return pdfmake.createPdf(def).getBuffer();
}

/** HTTP odgovor s PDF-om (inline = pregled u pregledniku/iframeu, inače preuzimanje). */
export function pdfResponse(buf: Buffer, fileName: string, inline = true) {
  const name = fileName.endsWith('.pdf') ? fileName : `${fileName}.pdf`;
  return new Response(new Uint8Array(buf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(buf.byteLength),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/[^\w.-]+/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
