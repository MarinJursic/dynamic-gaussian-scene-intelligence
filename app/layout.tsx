import type { Metadata } from "next";
import "./globals.css";


const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const metadataBase = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000");
const imageUrl = new URL(`${basePath}/og.png`, metadataBase).toString();

export const metadata: Metadata = {
  metadataBase,
  title: "Scene Reconstruction — Image-to-World Studio",
  description:
    "Turn images and videos into an explicitly bounded spatial preview, generate beyond doorways, and inspect trained SPZ/SOG Gaussian scenes.",
  icons: { icon: `${basePath}/favicon.png`, shortcut: `${basePath}/favicon.png` },
  openGraph: {
    title: "Scene Reconstruction — Image-to-World Studio",
    description: "Observed capture, labeled context completion, doorway expansion, and trained Gaussian inspection.",
    images: [{ url: imageUrl, width: 1672, height: 941, alt: "Scene Reconstruction image-to-world viewer" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Scene Reconstruction — Image-to-World Studio",
    description: "Observed capture, labeled context completion, doorway expansion, and trained Gaussian inspection.",
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
