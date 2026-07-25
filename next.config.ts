import type { NextConfig } from "next";

const pagesRepository = process.env.GITHUB_REPOSITORY?.split("/")[1];
const pagesBasePath =
  process.env.GITHUB_PAGES === "true" && pagesRepository
    ? `/${pagesRepository}`
    : "";

const nextConfig: NextConfig = {
  output: process.env.GITHUB_PAGES === "true" ? "export" : undefined,
  basePath: pagesBasePath,
  trailingSlash: process.env.GITHUB_PAGES === "true",
  images: { unoptimized: process.env.GITHUB_PAGES === "true" },
  env: { NEXT_PUBLIC_BASE_PATH: pagesBasePath },
};

export default nextConfig;
