import type { Metadata } from "next";
import type { ReactNode } from "react";
import Script from "next/script";

export const metadata: Metadata = {
  title: "Space Craft",
  description: "1v1 space combat with Direct Mode v2 authoritative server"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const sdkVersion = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 8) || "v3";

  return (
    <html lang="en">
      <head>
        <Script src={`/usion-sdk.js?v=${sdkVersion}`} strategy="beforeInteractive" />
      </head>
      <body style={{ margin: 0, background: "#020617", color: "#e2e8f0", fontFamily: "system-ui, sans-serif" }}>
        {children}
      </body>
    </html>
  );
}
