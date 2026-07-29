export type NavItem = { href: string; label: string; icon: string };

// Grouped navigation for the app sidebar. `icon` is an emoji for now —
// easy to swap for an icon set later without touching layout.
export const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: "Workspace",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: "🏠" },
      { href: "/upload", label: "Upload", icon: "⬆️" },
      { href: "/receipts", label: "Receipts", icon: "🧾" },
      { href: "/review", label: "Needs Review", icon: "⚠️" },
    ],
  },
  {
    title: "Statements",
    items: [
      { href: "/reconcile", label: "Close-Out", icon: "✅" },
      { href: "/statements", label: "Statements", icon: "📄" },
      { href: "/matching", label: "Matching", icon: "🔗" },
    ],
  },
  {
    title: "Reports",
    items: [{ href: "/reports", label: "Monthly Report", icon: "📊" }],
  },
  {
    title: "Settings",
    items: [
      { href: "/cards", label: "Cards", icon: "💳" },
      { href: "/categories", label: "Categories", icon: "🏷️" },
      { href: "/settings", label: "Settings", icon: "⚙️" },
    ],
  },
];
