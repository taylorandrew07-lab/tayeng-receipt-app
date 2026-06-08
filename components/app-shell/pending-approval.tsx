import Image from "next/image";
import { signout } from "@/lib/auth/actions";

export function PendingApproval({ email }: { email: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md text-center">
        <Image
          src="/logo.png"
          alt="Tayeng Receipts"
          width={72}
          height={72}
          className="mx-auto mb-4"
        />
        <h1 className="text-xl font-bold text-slate-900">Account awaiting approval</h1>
        <p className="mt-2 text-sm text-slate-500">
          Your account <span className="font-medium text-slate-700">{email}</span> has
          been created and is waiting for an administrator to approve access.
          You&apos;ll be able to sign in normally once it&apos;s approved.
        </p>
        <form action={signout} className="mt-6">
          <button
            type="submit"
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
          >
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}
