import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell/app-shell";
import { PendingApproval } from "@/components/app-shell/pending-approval";
import { UploadQueueProvider } from "@/components/upload/upload-queue";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();

  // Verify the session LOCALLY (asymmetric JWT) — no network round-trip.
  // The middleware already refreshed the token before this runs.
  const { data: claimsData } = await supabase.auth.getClaims();
  const claims = claimsData?.claims;
  if (!claims?.sub) {
    redirect("/login");
  }
  const userId = claims.sub as string;
  const email = (claims.email as string | undefined) ?? "";

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, role, approved")
    .eq("id", userId)
    .single();

  // Admin-approval gate: unapproved accounts can sign in but can't use the app.
  if (!profile?.approved) {
    return <PendingApproval email={email} />;
  }

  const isAdmin = profile.role === "admin" || profile.role === "super_admin";
  const userLabel = profile.full_name?.trim() || email || "Account";

  // Admins: surface how many accounts are waiting for approval.
  let pendingCount = 0;
  if (isAdmin) {
    const { count } = await supabase
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("approved", false);
    pendingCount = count ?? 0;
  }

  return (
    <UploadQueueProvider>
      <AppShell userLabel={userLabel} isAdmin={isAdmin} pendingCount={pendingCount}>
        {children}
      </AppShell>
    </UploadQueueProvider>
  );
}
