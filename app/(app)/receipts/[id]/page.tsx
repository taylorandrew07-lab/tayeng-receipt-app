import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import { ReceiptEditor } from "@/components/receipts/receipt-editor";
import type { Card, Category, Receipt } from "@/lib/types";

export default async function ReceiptEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: receipt } = await supabase
    .from("receipts")
    .select("*")
    .eq("id", id)
    .single();
  if (!receipt) notFound();

  const [{ data: file }, { data: cards }, { data: categories }] = await Promise.all([
    supabase
      .from("receipt_files")
      .select("storage_path, mime_type, file_name")
      .eq("receipt_id", id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase.from("cards").select("*").order("nickname"),
    supabase.from("categories").select("*").order("name"),
  ]);

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
          <Link href="/receipts" className="text-sm font-medium text-slate-600 underline">
            ← Back
          </Link>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <ReceiptEditor
            receipt={receipt as Receipt}
            cards={(cards ?? []) as Card[]}
            categories={(categories ?? []) as Category[]}
          />
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="mb-3 text-sm font-semibold text-slate-700">Original document</p>
          {!fileUrl ? (
            <p className="text-sm text-slate-400">No file attached.</p>
          ) : isPdf ? (
            <a
              href={fileUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block rounded-lg border border-slate-200 bg-slate-50 p-6 text-center text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              📄 Open PDF
            </a>
          ) : (
            <a href={fileUrl} target="_blank" rel="noopener noreferrer">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={fileUrl}
                alt="Receipt"
                className="w-full rounded-lg border border-slate-200"
              />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
