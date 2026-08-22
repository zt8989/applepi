import type { NextConfig } from 'next';

// ADR-0017 web shell: every agent API route lives on the shared runtime
// server (packages/server, 127.0.0.1:3210 by default). The browser stays
// same-origin — Next rewrites proxies /api/* to the server, so the frontend
// code is unchanged and no CORS is needed.
const API_PORT = process.env.APPLEPI_PORT ?? '3210';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `http://127.0.0.1:${API_PORT}/api/:path*` },
    ];
  },
};

export default nextConfig;