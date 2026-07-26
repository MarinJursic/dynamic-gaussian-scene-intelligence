import type { Metadata } from "next";
import "./globals.css";


const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const metadataBase = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000");
const imageUrl = new URL(`${basePath}/og.png`, metadataBase).toString();

export const metadata: Metadata = {
  metadataBase,
  title: "Spatial Capture Room — Photographic Context & 3DGS",
  description:
    "Review real 360° capture context, inspect reconstruction coverage, and open trained SPZ/SOG Gaussian scenes locally.",
  icons: { icon: `${basePath}/favicon.png`, shortcut: `${basePath}/favicon.png` },
  openGraph: {
    title: "Spatial Capture Room — Photographic Context & 3DGS",
    description: "Observed room capture, trained interior examples, and local SPZ/SOG inspection.",
    images: [{ url: imageUrl, width: 1672, height: 941, alt: "Spatial Capture Room viewer" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Spatial Capture Room — Photographic Context & 3DGS",
    description: "Observed room capture, trained interior examples, and local SPZ/SOG inspection.",
    images: [imageUrl],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="color-scheme" content="dark light" />
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(()=>{try{const saved=localStorage.getItem('dgsi-theme');const theme=saved==='light'||saved==='dark'?saved:(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme}catch{document.documentElement.dataset.theme='dark'}})()",
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
