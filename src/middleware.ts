import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/session-cookie';

/** Neprijavljene šalje na prijavu; stvarna provjera sesije i prava je na poslužitelju. */
export function middleware(req: NextRequest) {
  if (req.cookies.get(SESSION_COOKIE)?.value) return NextResponse.next();
  // API ne preusmjerava na prijavu nego javlja da korisnik nije prijavljen
  if (req.nextUrl.pathname.startsWith('/api/')) return NextResponse.json({ error: 'Niste prijavljeni.' }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = req.nextUrl.pathname !== '/' ? `?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}` : '';
  return NextResponse.redirect(url);
}

export const config = {
  // /api/mdm/agent/* — agenti uređaja (autentikacija tokenom uređaja, ne kolačićem; velika slanja ne smiju prolaziti middleware)
  // /api/mdm/files/upload — prijenos APK/MSI do 200 MB (sesiju i prava provjerava sama ruta)
  matcher: ['/((?!login|api/mdm/agent/|api/mdm/files/upload|_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest).*)'],
};
