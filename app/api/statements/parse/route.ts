import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { parseStatement } from "@/lib/extraction/parse-statement";
import { resolveMediaType } from "@/lib/files/media-type";
import { getApprovedUser, MAX_PDF_BYTES } from "@/lib/auth/guard";

export const maxDuration = 60;

const round2 = (n: number) => Math.round(n * 100) / 100;

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
  const mediaType = resolveMediaType(null, statement.file_name);
  const base64 = Buffer.from(await blob.arrayBuffer()).toString("base64");

  let parsed;
  try {
    parsed = await parseStatement({ base64, mediaType });
  } catch (e) {
    console.error("statement parsing failed:", e);
    return NextResponse.json({ error: "Parsing failed" }, { status: 502 });
  }

  // The direction check. Everything downstream — is_fee_description, "a PAYMENT
  // line is a payment to the card" — assumes a CREDIT CARD statement. On a
  // chequing statement those assumptions invert, so refuse rather than quietly
  // load a period's worth of backwards data.
  if (parsed.document_kind === "bank_account") {
    return NextResponse.json(
      {
        error:
          "This looks like a bank account statement, not a credit card statement. " +
          "The app reads credit card statements only — on a bank statement the debits " +
          "and credits run the opposite way and every line would be read backwards.",
      },
      { status: 422 }
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

  // Header fields are written ONLY when this parse actually read them.
  //
  // The previous version wrote period_start/period_end/card_id unconditionally
  // and did it BEFORE the confirmed-match guard, so a re-parse that failed to
  // read the header wiped a period 0014 had backfilled and unlinked the card —
  // and "latest statement" ordering is built on those dates.
  const header: Record<string, unknown> = {};
  if (parsed.period_start) header.period_start = parsed.period_start;
  if (parsed.period_end) header.period_end = parsed.period_end;
  if (card_id) header.card_id = card_id;
  if (parsed.previous_balance != null) header.previous_balance = parsed.previous_balance;
  if (parsed.total_purchases != null) header.total_purchases = parsed.total_purchases;
  if (parsed.total_payments != null) header.total_payments = parsed.total_payments;
  if (parsed.closing_balance != null) header.closing_balance = parsed.closing_balance;

  // Guard re-parse: if this statement already has CONFIRMED receipt matches,
  // re-parsing would throw away that reconciliation work. Keep the rows — but
  // still record the totals we just read, so an already-matched statement can
  // gain its control total without being re-parsed.
  const { data: existingTxns } = await supabase
    .from("statement_transactions")
    .select("id, amount")
    .eq("statement_id", statementId);
  const existingIds = (existingTxns ?? []).map((t) => t.id);

  if (existingIds.length > 0) {
    const { count: confirmedCount } = await supabase
      .from("receipt_statement_matches")
      .select("id", { count: "exact", head: true })
      .in("statement_transaction_id", existingIds)
      .eq("confirmed", true);

    if ((confirmedCount ?? 0) > 0) {
      const lineTotal = round2(
        (existingTxns ?? []).reduce((a, t) => a + Number(t.amount ?? 0), 0)
      );
      await supabase
        .from("statements")
        .update({ ...header, parsed_line_total: lineTotal })
        .eq("id", statementId);

      return NextResponse.json({
        ok: true,
        count: existingIds.length,
        totalPurchases: parsed.total_purchases,
        lineTotal,
        reconciled:
          parsed.total_purchases == null
            ? null
            : Math.abs(lineTotal - parsed.total_purchases) <= 0.01,
        message: "Kept existing transactions — this statement has confirmed matches.",
      });
    }
  }

  // Re-parse is idempotent (no confirmed matches): clear prior, insert fresh.
  await supabase.from("statement_transactions").delete().eq("statement_id", statementId);

  const fallbackLast4 = /^\d{4}$/.test(parsed.card_last4 ?? "") ? parsed.card_last4 : null;

  const priced = parsed.transactions.filter((t) => t.amount != null);
  // Credits (payments to the card, refunds) are real lines on the statement but
  // they are not spend and can never need a receipt, so they are not stored as
  // chargeable transactions. The COUNT is kept so "26 lines from a 29-line
  // statement" reads as accounted for rather than as three missing lines.
  const debits = priced.filter((t) => t.direction !== "credit");
  const creditsExcluded = priced.length - debits.length;

  const txns = debits.map((t) => ({
    statement_id: statementId,
    user_id: user.id,
    txn_date: t.date,
    description: t.description,
    amount: t.amount,
    currency: (t.currency ?? "TTD").toUpperCase(),
    card_last4: /^\d{4}$/.test(t.card_last4 ?? "") ? t.card_last4 : fallbackLast4,
  }));

  if (txns.length > 0) {
    const { error: insErr } = await supabase.from("statement_transactions").insert(txns);
    if (insErr) {
      return NextResponse.json({ error: insErr.message }, { status: 500 });
    }
  }

  const lineTotal = round2(txns.reduce((a, t) => a + Number(t.amount ?? 0), 0));

  const { error: updErr } = await supabase
    .from("statements")
    .update({ ...header, parsed_line_total: lineTotal, credits_excluded: creditsExcluded })
    .eq("id", statementId);
  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  const reconciled =
    parsed.total_purchases == null
      ? null
      : Math.abs(lineTotal - parsed.total_purchases) <= 0.01;

  return NextResponse.json({
    ok: true,
    count: txns.length,
    creditsExcluded,
    totalPurchases: parsed.total_purchases,
    lineTotal,
    reconciled,
    message:
      reconciled === null
        ? `Read ${txns.length} charges. This statement does not print a purchases total, so the app cannot prove every line was captured.`
        : reconciled
          ? `Read ${txns.length} charges totalling ${lineTotal.toFixed(2)} — matches the statement's own total exactly.`
          : `Read ${txns.length} charges totalling ${lineTotal.toFixed(2)}, but the statement says ${Number(
              parsed.total_purchases
            ).toFixed(2)}. Something was missed — check this statement before relying on it.`,
  });
}
