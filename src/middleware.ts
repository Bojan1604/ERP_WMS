import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { PORTAL_COOKIE } from '@/lib/portal-cookie';

/** Neprijavljene šalje na prijavu; stvarna provjera sesije i prava je na poslužitelju. */
export function middleware(req: NextRequest) {
  // portal za klijente ima vlastitu prijavu i kolačić — djelatnička sesija ovdje ne vrijedi
  const p = req.nextUrl.pathname;
  if (p === '/portal' || p.startsWith('/portal/')) return portalGate(req, p);
  if (req.cookies.get(SESSION_COOKIE)?.value) return NextResponse.next();
  // API ne preusmjerava na prijavu nego javlja da korisnik nije prijavljen
  if (req.nextUrl.pathname.startsWith('/api/')) return NextResponse.json({ error: 'Niste prijavljeni.' }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = req.nextUrl.pathname !== '/' ? `?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}` : '';
  return NextResponse.redirect(url);
}

function portalGate(req: NextRequest, p: string) {
  if (p === '/portal/prijava' || req.cookies.get(PORTAL_COOKIE)?.value) return NextResponse.next();
  if (p.startsWith('/portal/api/')) return NextResponse.json({ error: 'Niste prijavljeni.' }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = '/portal/prijava';
  url.search = '';
  return NextResponse.redirect(url);
}

export const config = {
  // /api/mdm/agent/* — agenti uređaja (autentikacija tokenom uređaja, ne kolačićem; velika slanja ne smiju prolaziti middleware)
  // /api/mdm/files/upload — prijenos APK/MSI do 200 MB (sesiju i prava provjerava sama ruta)
  matcher: ['/((?!login|api/mdm/agent/|api/mdm/files/upload|_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest).*)'],
};
