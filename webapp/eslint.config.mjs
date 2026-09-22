import nextConfig from "eslint-config-next/core-web-vitals";

const config = [
  ...nextConfig,
  {
    ignores: [".next/**", "coverage/**", "next-env.d.ts"],
  },
];

export default config;
