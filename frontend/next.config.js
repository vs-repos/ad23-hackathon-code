/** @type {import('next').NextConfig} */
// no /api rewrite here: a build-time destination makes `next build` fail when
// BACKEND_ORIGIN is unset. middleware.ts proxies /api/* per request instead.
const nextConfig = {
  reactStrictMode: true,
  // RelaxDev's builder starts `.next/standalone/server.js`.
  output: 'standalone',
  experimental: {
    // better-sqlite3 is a native addon: keep it out of the server bundle.
    serverComponentsExternalPackages: ['better-sqlite3'],
  },
};

module.exports = nextConfig;
