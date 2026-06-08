import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client — bypasses RLS. SERVER ONLY, and only after
 * verifying the caller is an admin. Used for auth-admin operations (listing
 * users, deleting users) that the anon/session client cannot do.
 */
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}
