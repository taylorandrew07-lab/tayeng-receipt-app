import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import { ReceiptEditor } from "@/components/receipts/receipt-editor";
import { DocumentViewer } from "@/components/receipts/document-viewer";
import { dismissDuplicate } from "@/lib/receipts/actions";
import type { Card, Category, Receipt } from "@/lib/types";

export default async function ReceiptEditPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { id } = await params;
  const { from } = await searchParams;
  // Opened from the review queue? Send the user back there after saving.
  const cameFromReview = from === "review";
  const backHref = cameFromReview ? "/review" : "/receipts";
  const supabase = await createClient();

  const { data: receipt } = await supabase
    .from("receipts")
    .select("*")
    .eq("id", id)
    .single();
  if (!receipt) notFound();

  const [{ data: file }, { data: cards }, { data: categories }, { data: settings }] =
    await Promise.all([
      supabase
        .from("receipt_files")
        .select("storage_path, mime_type, file_name")
        .eq("receipt_id", id)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
      supabase.from("cards").select("*").order("nickname"),
      supabase.from("categories").select("*").order("name"),
      supabase.from("user_settings").select("usd_to_ttd_rate").single(),
    ]);
  const usdToTtdRate = Number(settings?.usd_to_ttd_rate ?? 6.8);

  let fileUrl: string | null = null;
  if (file?.storage_path) {
    const { data: signed } = await supabase.storage
      .from("documents")
      .createSignedUrl(file.storage_path, 3600);
    fileUrl = signed?.signedUrl ?? null;
  }
  const isPdf = (file?.mime_type ?? "").includes("pdf") ||
    (file?.file_name ?? "").toLowerCase().endsWith(".pdf");

  return (
    <div>
      <PageHeader
        title="Review receipt"
        subtitle="Confirm or correct the details. Your changes are saved as rules for similar receipts."
        action={
          <Link href={backHref} className="text-sm font-medium text-slate-600 underline">
            ← Back{cameFromReview ? " to review" : ""}
          </Link>
        }
      />

      {receipt.duplicate_of && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm text-amber-800">
            ⚠️ This was flagged as a <strong>possible duplicate</strong> of another
            receipt. If it&apos;s a separate purchase (e.g. two fuel fill-ups for the
            same amount), mark it as not a duplicate.
          </p>
          <form action={dismissDuplicate}>
            <input type="hidden" name="id" value={receipt.id} />
            <button className="whitespace-nowrap rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">
              Not a duplicate
            </button>
          </form>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <ReceiptEditor
            receipt={receipt as Receipt}
            cards={(cards ?? []) as Card[]}
            categories={(categories ?? []) as Category[]}
            usdToTtdRate={usdToTtdRate}
            redirectTo={backHref}
          />
        </div>

        <DocumentViewer fileUrl={fileUrl} fileName={file?.file_name ?? null} isPdf={isPdf} />
      </div>
    </div>
  );
}
