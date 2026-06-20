import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/** The minimal identity our API routes need (id + email). */
export type ApprovedUser = { id: string; email: string | null };

/**
 * Returns the signed-in user only if their account is approved. API routes use
 * this so unapproved (or signed-out) users can't trigger work, on top of the
 * RLS approval enforcement at the database layer.
 *
 * Uses getClaims(), which verifies the JWT locally (asymmetric keys) instead of
 * making a network round-trip to the Auth server on every request.
 */
export async function getApprovedUser(
  supabase: SupabaseClient
): Promise<{ user: ApprovedUser | null; approved: boolean }> {
  const { data: claimsData } = await supabase.auth.getClaims();
  const claims = claimsData?.claims;
  if (!claims?.sub) return { user: null, approved: false };

  const user: ApprovedUser = {
    id: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
  };

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
