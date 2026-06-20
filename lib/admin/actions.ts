"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

type Role = "user" | "admin" | "super_admin";

async function requireAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!profile || (profile.role !== "admin" && profile.role !== "super_admin")) {
    return null;
  }
  return { supabase, userId: user.id, role: profile.role as Role };
}

async function targetRole(supabase: Awaited<ReturnType<typeof createClient>>, id: string) {
  const { data } = await supabase.from("profiles").select("role").eq("id", id).single();
  return (data?.role ?? null) as Role | null;
}

export async function approveUser(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const ctx = await requireAdmin();
  if (!ctx) return;
  // Approving a pending account is fine for any admin (RLS also enforces it).
  await ctx.supabase.from("profiles").update({ approved: true }).eq("id", id);
  revalidatePath("/admin");
}

export async function setUserRole(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const role = String(formData.get("role") ?? "user");
  if (!id || !["user", "admin"].includes(role)) return;
  const ctx = await requireAdmin();
  if (!ctx) return;
  // Only super_admins may change roles, and never their own / a super_admin's.
  if (ctx.role !== "super_admin" || id === ctx.userId) return;
  const tr = await targetRole(ctx.supabase, id);
  if (tr === "super_admin") return;
  await ctx.supabase.from("profiles").update({ role }).eq("id", id);
  revalidatePath("/admin");
}

export async function removeUser(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const ctx = await requireAdmin();
  if (!ctx) return;
  if (id === ctx.userId) return; // never delete yourself

  const tr = await targetRole(ctx.supabase, id);
  // A plain admin may only remove plain users. Admins/super_admins are
  // protected; only a super_admin may remove them.
  if (ctx.role !== "super_admin" && tr !== "user") return;
  if (tr === "super_admin" && ctx.role !== "super_admin") return;

  // Deleting the auth user cascades to all their data (profiles, receipts, …).
  const admin = createAdminClient();
  await admin.auth.admin.deleteUser(id);
  revalidatePath("/admin");
}
