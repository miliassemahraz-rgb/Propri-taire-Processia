import type { NextConfig } from 'next';

const apiUrl = process.env['API_URL'] ?? 'http://localhost:3001';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // L'API est servie sous le même domaine : cookie SameSite=Strict (spécification 1.1).
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/:path*` }];
  },
};

export default nextConfig;
