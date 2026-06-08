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
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Defense in depth — middleware already guards these routes.
  if (!user) {
    redirect("/login");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, role, approved")
    .eq("id", user.id)
    .single();

  // Admin-approval gate: unapproved accounts can sign in but can't use the app.
  if (!profile?.approved) {
    return <PendingApproval email={user.email ?? ""} />;
  }

  const isAdmin = profile.role === "admin" || profile.role === "super_admin";
  const userLabel = profile.full_name?.trim() || user.email || "Account";

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
