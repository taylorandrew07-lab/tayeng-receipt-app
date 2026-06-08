import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { User } from "@supabase/supabase-js";

/**
 * Returns the signed-in user only if their account is approved. API routes use
 * this so unapproved (or signed-out) users can't trigger work, on top of the
 * RLS approval enforcement at the database layer.
 */
export async function getApprovedUser(
  supabase: SupabaseClient
): Promise<{ user: User | null; approved: boolean }> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, approved: false };

  const { data } = await supabase
    .from("profiles")
    .select("approved")
    .eq("id", user.id)
    .single();

  return { user, approved: Boolean(data?.approved) };
}

// Upload/processing size ceilings (bytes). Mirrors what the model can handle
// and protects against cost/timeout/memory blowups.
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB
export const MAX_PDF_BYTES = 30 * 1024 * 1024; // 30 MB
