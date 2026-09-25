import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: { default: 'Portal za klijente', template: '%s · Portal za klijente' },
  robots: { index: false, follow: false },
};

export default function PortalRootLayout({ children }: { children: React.ReactNode }) {
  return children;
}
