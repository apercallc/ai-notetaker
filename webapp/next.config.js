/** @type {import('next').NextConfig} */

// CORS for the managed API lives in exactly one place: src/proxy.ts (via
// src/lib/cors.ts). Do not add Access-Control-* headers here, or the two
// blocks drift and disagree about allowed origins and headers.

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  // Directives that never block Next's inline bootstrap scripts, so no nonce
  // plumbing is needed: no framing, no plugins, no base-tag or form hijacking.
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
  },
];

const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
