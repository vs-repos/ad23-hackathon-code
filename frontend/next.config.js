/** @type {import('next').NextConfig} */
// no /api rewrite here: a build-time destination makes `next build` fail when
// BACKEND_ORIGIN is unset. middleware.ts proxies /api/* per request instead.
const nextConfig = {
  reactStrictMode: true,
};

module.exports = nextConfig;
