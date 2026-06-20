import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { parseStatement } from "@/lib/extraction/parse-statement";
import { getApprovedUser, MAX_PDF_BYTES } from "@/lib/auth/guard";

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { user, approved } = await getApprovedUser(supabase);
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!approved) {
    return NextResponse.json({ error: "Account not approved" }, { status: 403 });
  }

  let statementId: string;
  try {
    statementId = String((await request.json()).statementId ?? "");
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  if (!statementId) {
    return NextResponse.json({ error: "Missing statementId" }, { status: 400 });
  }

  const { data: statement } = await supabase
    .from("statements")
    .select("id, storage_path, file_name")
    .eq("id", statementId)
    .single();
  if (!statement) {
    return NextResponse.json({ error: "Statement not found" }, { status: 404 });
  }

  const { data: blob, error: dlError } = await supabase.storage
    .from("documents")
    .download(statement.storage_path);
  if (dlError || !blob) {
    return NextResponse.json({ error: "Could not read file" }, { status: 500 });
  }

  if (blob.size > MAX_PDF_BYTES) {
    return NextResponse.json({ error: "File too large" }, { status: 413 });
  }
  const name = (statement.file_name ?? "").toLowerCase();
  const mediaType = name.endsWith(".pdf")
    ? "application/pdf"
    : name.endsWith(".png")
      ? "image/png"
      : "image/jpeg";
  const base64 = Buffer.from(await blob.arrayBuffer()).toString("base64");

  let parsed;
  try {
    parsed = await parseStatement({ base64, mediaType });
  } catch (e) {
    return NextResponse.json(
      { error: "Parsing failed", detail: String(e) },
      { status: 502 }
    );
  }

  // Link to a known card by last 4, if any.
  let card_id: string | null = null;
  if (parsed.card_last4) {
    const { data: card } = await supabase
      .from("cards")
      .select("id")
      .eq("last4", parsed.card_last4)
      .limit(1)
      .maybeSingle();
    card_id = card?.id ?? null;
  }

  await supabase
    .from("statements")
    .update({
      period_start: parsed.period_start,
      period_end: parsed.period_end,
      card_id,
    })
    .eq("id", statementId);

  // Guard re-parse: if this statement already has CONFIRMED receipt matches,
  // re-parsing would cascade-delete that reconciliation work. Refuse instead.
  const { data: existingTxns } = await supabase
    .from("statement_transactions")
    .select("id")
    .eq("statement_id", statementId);
  const existingIds = (existingTxns ?? []).map((t) => t.id);
  if (existingIds.length > 0) {
    const { count: confirmedCount } = await supabase
      .from("receipt_statement_matches")
      .select("id", { count: "exact", head: true })
      .in("statement_transaction_id", existingIds)
      .eq("confirmed", true);
    if ((confirmedCount ?? 0) > 0) {
      return NextResponse.json(
        {
          ok: true,
          count: existingIds.length,
          message: "Kept existing transactions — this statement has confirmed matches.",
        },
        { status: 200 }
      );
    }
  }

  // Re-parse is idempotent (no confirmed matches): clear prior, insert fresh.
  await supabase.from("statement_transactions").delete().eq("statement_id", statementId);

  const fallbackLast4 = /^\d{4}$/.test(parsed.card_last4 ?? "")
    ? parsed.card_last4
    : null;
  const txns = parsed.transactions
    .filter((t) => t.amount != null)
    .map((t) => ({
      statement_id: statementId,
      user_id: user.id,
      txn_date: t.date,
      description: t.description,
      amount: t.amount,
      currency: (t.currency ?? "TTD").toUpperCase(),
      card_last4: /^\d{4}$/.test(t.card_last4 ?? "") ? t.card_last4 : fallbackLast4,
    }));

  if (txns.length > 0) {
    const { error: insErr } = await supabase
      .from("statement_transactions")
      .insert(txns);
    if (insErr) {
      return NextResponse.json({ error: insErr.message }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true, count: txns.length });
}
