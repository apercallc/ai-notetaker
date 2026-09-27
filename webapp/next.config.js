/** @type {import('next').NextConfig} */

// CORS for the managed API lives in exactly one place: src/proxy.ts (via
// src/lib/cors.ts). Do not add Access-Control-* headers here, or the two
// blocks drift and disagree about allowed origins and headers.

const isProduction = process.env.NODE_ENV === "production";

// Next.js emits inline bootstrap scripts and styles, so 'unsafe-inline' is
// required without a per-request nonce; everything else is locked to this
// origin. React's dev overlay needs eval outside production only. Stripe
// hosts appear in form-action because a billing form POSTs here and is then
// redirected to Stripe Checkout / the billing portal.
const sentryIngest = process.env.NEXT_PUBLIC_SENTRY_DSN?.trim()
  ? new URL(process.env.NEXT_PUBLIC_SENTRY_DSN).origin
  : null;

const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProduction ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob:${sentryIngest ? ` ${sentryIngest}` : ""}`,
  "font-src 'self' data:",
  "media-src 'self' blob:",
  `connect-src 'self'${sentryIngest ? ` ${sentryIngest}` : ""}${isProduction ? "" : " ws: wss:"}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
