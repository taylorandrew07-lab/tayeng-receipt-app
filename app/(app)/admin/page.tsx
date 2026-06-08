import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHeader } from "@/components/ui";
import { approveUser, removeUser, setUserRole } from "@/lib/admin/actions";

type ProfileRow = {
  id: string;
  full_name: string | null;
  role: string;
  approved: boolean;
};

export default async function AdminPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!me || (me.role !== "admin" && me.role !== "super_admin")) {
    redirect("/dashboard");
  }

  // Profiles (admin RLS lets us read all) + auth emails (service role).
  const { data: profileData } = await supabase
    .from("profiles")
    .select("id, full_name, role, approved")
    .order("created_at", { ascending: true });
  const profiles = (profileData ?? []) as ProfileRow[];

  const admin = createAdminClient();
  const { data: authList } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const emailById = new Map(
    (authList?.users ?? []).map((u) => [u.id, u.email ?? ""])
  );

  const pending = profiles.filter((p) => !p.approved);
  const active = profiles.filter((p) => p.approved);

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Users"
        subtitle="Approve new sign-ups and manage who can access the app."
      />

      <h2 className="mb-3 font-semibold text-slate-900">
        Pending approval{pending.length > 0 ? ` (${pending.length})` : ""}
      </h2>
      {pending.length === 0 ? (
        <div className="mb-8 rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
          No one is waiting for approval.
        </div>
      ) : (
        <ul className="mb-8 space-y-3">
          {pending.map((p) => (
            <li
              key={p.id}
              className="flex items-center justify-between gap-4 rounded-xl border border-amber-200 bg-white p-4 shadow-sm"
            >
              <div className="min-w-0">
                <p className="font-medium text-slate-900">
                  {p.full_name?.trim() || emailById.get(p.id) || "New user"}
                </p>
                <p className="truncate text-xs text-slate-400">{emailById.get(p.id)}</p>
              </div>
              <div className="flex items-center gap-2">
                <form action={approveUser}>
                  <input type="hidden" name="id" value={p.id} />
                  <button className="rounded-lg bg-green-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-green-700">
                    Approve
                  </button>
                </form>
                <form action={removeUser}>
                  <input type="hidden" name="id" value={p.id} />
                  <button className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-red-50 hover:text-red-700">
                    Reject
                  </button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h2 className="mb-3 font-semibold text-slate-900">Active users</h2>
      <ul className="space-y-2">
        {active.map((p) => (
          <li
            key={p.id}
            className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
          >
            <div className="min-w-0">
              <p className="font-medium text-slate-900">
                {p.full_name?.trim() || emailById.get(p.id) || "User"}
                {p.id === user.id && (
                  <span className="ml-2 text-xs font-normal text-slate-400">(you)</span>
                )}
              </p>
              <p className="truncate text-xs text-slate-400">{emailById.get(p.id)}</p>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                  p.role === "admin" || p.role === "super_admin"
                    ? "bg-blue-100 text-blue-800"
                    : "bg-slate-100 text-slate-600"
                }`}
              >
                {p.role === "user" ? "User" : "Admin"}
              </span>
              {p.id !== user.id && (
                <>
                  <form action={setUserRole}>
                    <input type="hidden" name="id" value={p.id} />
                    <input
                      type="hidden"
                      name="role"
                      value={p.role === "user" ? "admin" : "user"}
                    />
                    <button className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100">
                      Make {p.role === "user" ? "admin" : "user"}
                    </button>
                  </form>
                  <form action={removeUser}>
                    <input type="hidden" name="id" value={p.id} />
                    <button className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-400 hover:bg-red-50 hover:text-red-700">
                      Remove
                    </button>
                  </form>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
