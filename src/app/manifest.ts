import type { MetadataRoute } from 'next';

/** Instalacija na mobitel („Dodaj na početni zaslon") — otvara se kao zasebna aplikacija. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'ERP · WMS',
    short_name: 'ERP WMS',
    description: 'Skladište, prodaja, najam i servis opreme',
    start_url: '/',
    display: 'standalone',
    background_color: '#15201d',
    theme_color: '#15201d',
    lang: 'hr',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
    shortcuts: [
      { name: 'Skeniranje', url: '/skladiste/skeniranje' },
      { name: 'Inventura', url: '/skladiste/inventura' },
      { name: 'Računi', url: '/prodaja/racuni' },
    ],
  };
}
