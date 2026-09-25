import type { NextConfig } from 'next';

const commonHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'same-origin' },
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
];
const securityHeaders = [{ key: 'X-Frame-Options', value: 'DENY' }, ...commonHeaders];
// PDF dokumenata se prikazuje u pregledu (iframe) unutar aplikacije — samo s istog izvora
const pdfHeaders = [{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }, { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" }, ...commonHeaders];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  serverExternalPackages: ['@prisma/client', 'bcryptjs', 'bwip-js', 'node-forge', 'xml-crypto', '@xmldom/xmldom', 'pdfmake', 'exceljs', 'nodemailer'],
  experimental: {
    optimizePackageImports: ['lucide-react'],
    serverActions: { bodySizeLimit: '50mb' },
    // već otvorena stranica se pri povratku prikazuje odmah (osvježava se nakon izmjene)
    staleTimes: { dynamic: 30, static: 300 },
  },
  async headers() {
    return [
      { source: '/((?!api/pdf/).*)', headers: securityHeaders },
      { source: '/api/pdf/:path*', headers: pdfHeaders },
    ];
  },
};

export default config;
