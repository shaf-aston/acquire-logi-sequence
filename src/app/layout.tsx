import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Logi — PDF Ingestion",
  description: "Stage 1: visual PDF ingestion and table conversion via Mistral OCR",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Apply the saved theme before first paint so a returning dark-mode user never
            sees a flash of the light theme. No saved choice → the CSS media query follows
            the OS. Kept tiny and inline; the ThemeToggle owns writing localStorage. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();",
          }}
        />
      </head>
      <body
        style={{
          margin: 0,
          fontFamily:
            "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
          background: "var(--color-page-bg)",
          color: "var(--color-text)",
          WebkitFontSmoothing: "antialiased",
          MozOsxFontSmoothing: "grayscale",
          lineHeight: 1.5,
        }}
      >
        {children}
      </body>
    </html>
  );
}
