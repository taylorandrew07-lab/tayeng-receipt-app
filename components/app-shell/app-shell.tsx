"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { NAV_GROUPS } from "./nav";
import { signout } from "@/lib/auth/actions";
import { Toaster } from "@/components/toast";

export function AppShell({
  children,
  userLabel,
  isAdmin = false,
  pendingCount = 0,
}: {
  children: React.ReactNode;
  userLabel: string;
  isAdmin?: boolean;
  pendingCount?: number;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  const itemClass = (active: boolean) =>
    `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition duration-150 ease-out ${
      active
        ? "bg-slate-900 text-white shadow-sm"
        : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
    }`;

  return (
    <div className="min-h-screen bg-background text-slate-900">
      {/* Mobile top bar — menu button on the LEFT */}
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-slate-200 bg-white/85 px-4 py-3 backdrop-blur-md md:hidden">
        <button
          onClick={() => setOpen((v) => !v)}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm active:scale-95"
          aria-label="Toggle menu"
        >
          ☰
        </button>
        <span className="flex items-center gap-2 font-semibold tracking-tight">
          <Image src="/logo.png" alt="" width={24} height={24} />
          Tayeng Receipts
        </span>
      </header>

      <div className="md:flex">
        {/* Sidebar */}
        <aside
          className={`${
            open ? "block" : "hidden"
          } w-full border-b border-slate-200 bg-white md:sticky md:top-0 md:block md:h-screen md:w-64 md:shrink-0 md:border-b-0 md:border-r`}
        >
          <div className="hidden items-center gap-2.5 px-5 py-5 md:flex">
            <Image src="/logo.png" alt="" width={32} height={32} />
            <span className="text-lg font-bold tracking-tight">Tayeng Receipts</span>
          </div>

          <nav className="px-3 py-3 md:py-1">
            {NAV_GROUPS.map((group) => (
              <div key={group.title} className="mb-5">
                <p className="px-3 pb-1.5 text-[0.7rem] font-semibold uppercase tracking-wider text-slate-400">
                  {group.title}
                </p>
                {group.items.map((item) => {
                  const active =
                    pathname === item.href ||
                    pathname.startsWith(item.href + "/");
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setOpen(false)}
                      className={itemClass(active)}
                    >
                      <span aria-hidden className="text-base">
                        {item.icon}
                      </span>
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            ))}

            {isAdmin && (
              <div className="mb-5">
                <p className="px-3 pb-1.5 text-[0.7rem] font-semibold uppercase tracking-wider text-slate-400">
                  Admin
                </p>
                <Link
                  href="/admin"
                  onClick={() => setOpen(false)}
                  className={itemClass(pathname.startsWith("/admin"))}
                >
                  <span aria-hidden className="text-base">
                    👤
                  </span>
                  Users
                  {pendingCount > 0 && (
                    <span className="ml-auto rounded-full bg-amber-500 px-2 py-0.5 text-xs font-semibold text-white">
                      {pendingCount}
                    </span>
                  )}
                </Link>
              </div>
            )}
          </nav>

          <div className="border-t border-slate-200 p-3">
            <p className="truncate px-3 pb-2 text-xs text-slate-500">{userLabel}</p>
            <form action={signout}>
              <button
                type="submit"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100 active:scale-[0.99]"
              >
                Sign out
              </button>
            </form>
          </div>
        </aside>

        {/* Main content — fades up on each route change */}
        <main
          key={pathname}
          className="fade-up min-h-screen flex-1 px-4 py-6 md:px-8 md:py-9"
        >
          <div className="mx-auto max-w-6xl">{children}</div>
        </main>
      </div>
      <Toaster />
    </div>
  );
}
