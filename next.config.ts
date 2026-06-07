import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the PDF renderer out of the bundler — it relies on Node internals.
  serverExternalPackages: ["@react-pdf/renderer"],
};

export default nextConfig;
