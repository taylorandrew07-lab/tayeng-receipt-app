import type { MetadataRoute } from "next";

// Web App Manifest — makes the site installable on phones (Android "Install app"
// / iOS "Add to Home Screen") with the logo icon and a fullscreen, app-like UI.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Tayeng Receipts",
    short_name: "Tayeng",
    description: "Receipt, invoice & statement processing for company expenses",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: "#0f172a",
    icons: [
      { src: "/logo.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/logo.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}
