import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL("http://localhost:3000"),
  title: "DGSI — Dynamic Gaussian Scene Intelligence",
  description:
    "Inspect, compare, stream, measure, and understand reconstructed spatial scenes.",
  icons: { icon: "/favicon.png", shortcut: "/favicon.png" },
  openGraph: {
    title: "DGSI — Dynamic Gaussian Scene Intelligence",
    description: "Inspect. Compare. Understand.",
    images: [{ url: "/og.png", width: 1728, height: 960, alt: "DGSI spatial scene intelligence viewer" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "DGSI — Dynamic Gaussian Scene Intelligence",
    description: "Inspect. Compare. Understand.",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
