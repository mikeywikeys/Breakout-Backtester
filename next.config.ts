// next.config.ts
import type { NextConfig } from "next";

const repo = process.env.GITHUB_REPOSITORY?.split("/")[1] ?? "";

const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
  basePath: "/Breakout-Backtester",
  assetPrefix: "/Breakout-Backtester/",
};

export default nextConfig;
