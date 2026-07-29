import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { extractDocument } from "@/lib/extraction/extract";
import { classify } from "@/lib/classification/classify";
import { duplicateKeys } from "@/lib/receipts/duplicates";
import { resolveMediaType } from "@/lib/files/media-type";
import { getApprovedUser, MAX_IMAGE_BYTES, MAX_PDF_BYTES } from "@/lib/auth/guard";
import type { Card, Category, LearningRule } from "@/lib/types";

export const maxDuration = 60; // allow time for model extraction

/**
 * Runs extraction + classification on one uploaded receipt and saves the
 * results. Auth + RLS guarantee the caller can only touch their own data.
 * Body: { receiptId: string }
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { user, approved } = await getApprovedUser(supabase);
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  if (!approved) {
    return NextResponse.json({ error: "Account not approved" }, { status: 403 });
  }

  let receiptId: string;
  try {
    const body = await request.json();
    receiptId = String(body.receiptId ?? "");
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  if (!receiptId) {
    return NextResponse.json({ error: "Missing receiptId" }, { status: 400 });
  }

  // Load the receipt (RLS scopes to this user) and its primary file.
  const { data: receipt } = await supabase
    .from("receipts")
    .select("id, created_at")
    .eq("id", receiptId)
    .single();
  if (!receipt) {
    return NextResponse.json({ error: "Receipt not found" }, { status: 404 });
  }

  const { data: file } = await supabase
    .from("receipt_files")
    .select("storage_path, mime_type, file_name")
    .eq("receipt_id", receiptId)
    .order("created_at", { ascending: true })
    .limit(1)
    .single();
  if (!file) {
    await supabase
      .from("receipts")
      .update({ status: "needs_review", notes: "No file was attached." })
      .eq("id", receiptId);
    return NextResponse.json({ error: "No file for receipt" }, { status: 400 });
  }

  // Download the file bytes from Storage.
  const { data: blob, error: dlError } = await supabase.storage
    .from("documents")
    .download(file.storage_path);
  if (dlError || !blob) {
    await supabase
      .from("receipts")
      .update({ status: "needs_review", notes: "Could not read the uploaded file." })
      .eq("id", receiptId);
    return NextResponse.json(
      { error: "Could not read uploaded file" },
      { status: 500 }
    );
  }

  const mediaType = resolveMediaType(file.mime_type, file.file_name);

  // Server-side type + size validation (client filters can be bypassed).
  const ALLOWED = ["image/jpeg", "image/png", "application/pdf"];
  if (!ALLOWED.includes(mediaType)) {
    await supabase
      .from("receipts")
      .update({ status: "needs_review", notes: "Unsupported file type." })
      .eq("id", receiptId);
    return NextResponse.json({ error: "Unsupported file type" }, { status: 415 });
  }
  const limit = mediaType === "application/pdf" ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
  if (blob.size > limit) {
    await supabase
      .from("receipts")
      .update({ status: "needs_review", notes: "File is too large to process." })
      .eq("id", receiptId);
    return NextResponse.json({ error: "File too large" }, { status: 413 });
  }

  const base64 = Buffer.from(await blob.arrayBuffer()).toString("base64");

  // Extract with Claude, then classify with the user's rules.
  let extraction;
  try {
    extraction = await extractDocument({
      base64,
      mediaType,
      fileName: file.file_name,
    });
  } catch (e) {
    console.error("extraction failed:", e);
    // "Automatic extraction failed." told the user nothing, so a service-level
    // outage looked like a bad document — five re-uploads of a perfectly good
    // invoice, including converting it to a screenshot. Name the real cause.
    const err = e as { status?: number; message?: string };
    const raw = err?.message ?? "";
    const reason = /credit balance is too low/i.test(raw)
      ? "The extraction service has run out of credit. Add credits at console.anthropic.com under Plans & Billing, then upload again — nothing is wrong with this document."
      : err?.status === 401
        ? "The extraction service rejected our API key. Check ANTHROPIC_API_KEY."
        : err?.status === 429
          ? "The extraction service is rate-limited right now. Wait a minute and try again."
          : err?.status === 529 || /overloaded/i.test(raw)
            ? "The extraction service is overloaded. Try again shortly."
            : /timeout|ETIMEDOUT|aborted/i.test(raw)
              ? "Reading this document took too long. Try a smaller or clearer file."
              : "Automatic extraction failed. The document was uploaded and is safe — you can fill the details in by hand.";

    await supabase
      .from("receipts")
      .update({ status: "needs_review", notes: reason })
      .eq("id", receiptId);
    return NextResponse.json({ error: reason }, { status: 502 });
  }

  const [{ data: cards }, { data: categories }, { data: rules }, { data: settings }] =
    await Promise.all([
      supabase.from("cards").select("*"),
      supabase.from("categories").select("*"),
      supabase.from("learning_rules").select("*"),
      supabase.from("user_settings").select("usd_to_ttd_rate").single(),
    ]);

  const result = classify({
    extraction,
    cards: (cards ?? []) as Card[],
    categories: (categories ?? []) as Category[],
    rules: (rules ?? []) as LearningRule[],
    usdToTtdRate: Number(settings?.usd_to_ttd_rate ?? 6.8),
    // Bucket by the upload time (handles auto-resume days later correctly).
    uploadedAt: new Date(receipt.created_at),
  });

  // --- Duplicate detection ---------------------------------------------
  // A receipt is a likely duplicate of an existing one if they share any
  // fingerprint key (see duplicateKeys). The earliest upload stays the original.
  let duplicateOf: string | null = null;
  {
    const newKeys = new Set(
      duplicateKeys({
        receipt_date: result.receipt_date,
        vendor_name: result.vendor_name,
        ttd_amount: result.ttd_amount,
        amount: result.amount,
        card_last4: result.card_last4,
        fileName: file.file_name,
      })
    );

    const { data: candidates } = await supabase
      .from("receipts")
      .select("id, receipt_date, vendor_name, ttd_amount, amount, card_last4, receipt_files(file_name)")
      .neq("id", receiptId)
      .is("duplicate_of", null);

    const match = (
      (candidates ?? []) as {
        id: string;
        receipt_date: string | null;
        vendor_name: string | null;
        ttd_amount: number | null;
        amount: number | null;
        card_last4: string | null;
        receipt_files: { file_name: string }[];
      }[]
    ).find((c) =>
      duplicateKeys({
        receipt_date: c.receipt_date,
        vendor_name: c.vendor_name,
        ttd_amount: c.ttd_amount,
        amount: c.amount,
        card_last4: c.card_last4,
        fileName: c.receipt_files?.[0]?.file_name ?? null,
      }).some((k) => newKeys.has(k))
    );
    if (match) duplicateOf = match.id;
  }

  const reviewReasons = duplicateOf
    ? ["Possible duplicate of an existing receipt", ...result.review_reasons]
    : result.review_reasons;
  const finalStatus = duplicateOf ? "needs_review" : result.status;

  const { error: upError } = await supabase
    .from("receipts")
    .update({
      duplicate_of: duplicateOf,
      doc_type: result.doc_type,
      receipt_date: result.receipt_date,
      month_key: result.month_key,
      vendor_name: result.vendor_name,
      amount: result.amount,
      currency: result.currency,
      ttd_amount: result.ttd_amount,
      tax_amount: result.tax_amount,
      payment_method: result.payment_method,
      card_id: result.card_id,
      card_last4: result.card_last4,
      category_id: result.category_id,
      reimbursable: result.reimbursable,
      status: finalStatus,
      confidence: result.confidence,
      raw_extraction: extraction,
      notes: reviewReasons.length > 0 ? reviewReasons.join("; ") : null,
    })
    .eq("id", receiptId);

  if (upError) {
    return NextResponse.json({ error: upError.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    status: finalStatus,
    duplicate: Boolean(duplicateOf),
    result,
  });
}
