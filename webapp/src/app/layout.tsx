import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Notetaker",
  description: "Your self-hosted meeting notes archive.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
