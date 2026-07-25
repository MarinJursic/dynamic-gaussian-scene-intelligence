import type { Metadata } from "next";
import "./globals.css";


const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const metadataBase = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000");
const imageUrl = new URL(`${basePath}/og.png`, metadataBase).toString();

export const metadata: Metadata = {
  metadataBase,
  title: "DGSI — Dynamic Gaussian Scene Intelligence",
  description:
    "Inspect, compare, stream, measure, and understand reconstructed spatial scenes.",
  icons: { icon: `${basePath}/favicon.png`, shortcut: `${basePath}/favicon.png` },
  openGraph: {
    title: "DGSI — Dynamic Gaussian Scene Intelligence",
    description: "Inspect. Compare. Understand.",
    images: [{ url: imageUrl, width: 1672, height: 941, alt: "DGSI spatial scene intelligence viewer" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "DGSI — Dynamic Gaussian Scene Intelligence",
    description: "Inspect. Compare. Understand.",
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
