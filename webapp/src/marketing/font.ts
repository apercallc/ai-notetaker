import localFont from "next/font/local";

/**
 * Bricolage Grotesque (SIL Open Font License 1.1), self-hosted so the public
 * site makes no third-party font request. One variable file covers every
 * weight, width and optical size the marketing pages use.
 */
export const display = localFont({
  src: "./fonts/BricolageGrotesque-Variable.woff2",
  variable: "--font-display",
  weight: "200 800",
  display: "swap",
  fallback: ["system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
});
