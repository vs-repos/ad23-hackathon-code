/** @type {import('next').NextConfig} */
const backendOrigin = process.env.BACKEND_ORIGIN || 'http://127.0.0.1:8000';

const nextConfig = {
  reactStrictMode: true,
  // The browser only ever calls same-origin /api/*; this rewrite proxies it to
  // FastAPI using a server-side env value, so the origin never reaches the bundle.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${backendOrigin}/api/:path*` }];
  },
};

module.exports = nextConfig;
