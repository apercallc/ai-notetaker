/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    const configuredOrigin = process.env.MANAGED_EXTENSION_ORIGIN;
    const extensionOrigin = configuredOrigin && /^(?:chrome|moz)-extension:\/\/[^/?#]+\/?$/.test(configuredOrigin)
      ? configuredOrigin.replace(/\/$/, "")
      : "chrome-extension://jidooookkdbbbhkkdmcajnnnhhphodok";
    return [{
      source: "/api/v1/:path*",
      headers: [
        { key: "Access-Control-Allow-Origin", value: extensionOrigin },
        { key: "Access-Control-Allow-Headers", value: "Authorization, Content-Type, Idempotency-Key, X-Chunk-Sha256, X-Audio-Channel, X-Request-Id, Stripe-Signature" },
        { key: "Access-Control-Allow-Methods", value: "GET, POST, PUT, OPTIONS" },
        { key: "Access-Control-Max-Age", value: "600" },
      ],
    }];
  },
};

export default nextConfig;
