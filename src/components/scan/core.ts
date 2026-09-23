/**
 * Čisti dijelovi skenera (bez Reacta i preglednika) — testiraju se u node:test.
 *   • createDedupe: isti kod unutar ~2 s je isti prolaz kamere preko naljepnice
 *   • createWedgeDetector: ručni čitač („keyboard wedge") tipka brzo i završava Enterom
 *   • cameraSupport: kamera radi samo na HTTPS-u ili localhostu
 */

/** Formati koje čitamo (nazivi BarcodeDetector API-ja). */
export const NATIVE_FORMATS = ['code_128', 'code_39', 'code_93', 'codabar', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf', 'qr_code', 'data_matrix'] as const;

/** Vraća funkciju koja kaže treba li kod prihvatiti (false = isti kod unutar prozora). */
export function createDedupe(windowMs = 2000) {
  const last = new Map<string, number>();
  return (code: string, now: number): boolean => {
    const prev = last.get(code);
    last.set(code, now);
    // čišćenje starih zapisa da mapa ne raste bez granice
    if (last.size > 200) for (const [k, t] of last) if (now - t > windowMs) last.delete(k);
    return prev === undefined || now - prev > windowMs;
  };
}

export interface WedgeOptions {
  /** Najveći razmak između znakova istog očitanja (ms). Ljudi tipkaju sporije od ~80 ms. */
  maxGapMs?: number;
  /** Najkraći kod koji se prihvaća. */
  minLength?: number;
}

/**
 * Prepoznaje očitanje ručnog čitača izvan polja za unos: niz znakova s malim
 * razmakom, završen Enterom (ili Tabom). Sporo tipkanje se odbacuje.
 * `key` vraća pročitani kod kad je niz završen, inače null.
 */
export function createWedgeDetector({ maxGapMs = 50, minLength = 3 }: WedgeOptions = {}) {
  let buf = '';
  let lastAt = 0;
  const reset = () => {
    buf = '';
  };
  return {
    reset,
    key(key: string, at: number): string | null {
      if (key === 'Enter' || key === 'Tab') {
        // Enter mora doći odmah iza zadnjeg znaka (čitač), ne nakon pauze (čovjek)
        const code = buf.length >= minLength && at - lastAt <= maxGapMs * 3 ? buf : null;
        reset();
        return code;
      }
      if (key.length !== 1) return null; // Shift, Alt… ne prekidaju niz
      // pauza između znakova = novi niz (sporo tipkanje nikad ne naraste do koda)
      if (buf && at - lastAt > maxGapMs) buf = '';
      buf += key;
      lastAt = at;
      return null;
    },
  };
}

export type CameraSupport = 'ok' | 'insecure' | 'unsupported';

/** Može li preglednik uopće pokrenuti kameru (sigurna veza + getUserMedia). */
export function cameraSupport(env: { isSecureContext?: boolean; hostname?: string; hasGetUserMedia: boolean }): CameraSupport {
  const local = env.hostname === 'localhost' || env.hostname === '127.0.0.1' || env.hostname === '[::1]';
  if (!env.isSecureContext && !local) return 'insecure';
  if (!env.hasGetUserMedia) return 'unsupported';
  return 'ok';
}

/** Poruka za grešku kamere (DOMException.name iz getUserMedia). */
export function cameraErrorMessage(name: string | undefined): string {
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Pristup kameri je odbijen. Dopustite kameru u postavkama preglednika (ikona lokota uz adresu) pa pokušajte ponovno.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Kamera nije pronađena na ovom uređaju.';
    case 'NotReadableError':
    case 'AbortError':
      return 'Kameru trenutačno koristi druga aplikacija. Zatvorite je i pokušajte ponovno.';
    default:
      return 'Kamera se ne može pokrenuti. Upišite kod ručno ili ga očitajte ručnim čitačem.';
  }
}

/** Ključ u sessionStorage kojim skeniranje predaje nepoznate serijske zaprimanju. */
export const RECEIVE_PREFILL_KEY = 'receive.serials';
