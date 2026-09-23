import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'ERP · WMS', template: '%s · ERP · WMS' },
  description: 'Skladište, prodaja, najam i servis opreme po serijskim brojevima',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#15201d' };

// Tema se postavlja prije prvog iscrtavanja da ne bljesne svijetla.
const themeScript = `try{var t=localStorage.getItem('theme');if(t==='dark'||(!t&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.dataset.theme='dark'}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="hr" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
