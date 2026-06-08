import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep native/Node-internal packages out of the bundler.
  serverExternalPackages: [
    "@react-pdf/renderer",
    "pdf-to-img",
    "pdfjs-dist",
    "@napi-rs/canvas",
  ],
};

export default nextConfig;
