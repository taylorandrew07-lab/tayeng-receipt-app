import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { parseStatement } from "@/lib/extraction/parse-statement";
import { resolveMediaType } from "@/lib/files/media-type";
import { getApprovedUser, MAX_PDF_BYTES } from "@/lib/auth/guard";
import { validateParsedStatement } from "@/lib/statements/validate";

export const maxDuration = 60;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Read a statement and (re)place its lines.
 *
 * Order matters, and is the whole point of this route's design:
 *   1. read the document            — changes nothing
 *   2. VALIDATE the reading         — changes nothing; refuses bad readings
 *   3. replace_statement_lines()    — ONE transaction (0025): guard, header,
 *                                     delete and insert commit together or
 *                                     not at all
 * The previous flow deleted the existing lines before it knew whether the new
 * reading was any good, as separate network calls, so a failed or empty parse
 * wiped a statement that had been correct.
 *
 * Retrying is safe: call it again with the SAME statementId. Nothing is ever
 * re-uploaded, so a retry can never create a second copy of the statement.
 */
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
    .from("statement_coverage")
    .select("id, storage_path, file_name, txn_count, totals_reconciled")
    .eq("id", statementId)
    .maybeSingle();
  if (!statement) {
    return NextResponse.json({ error: "Statement not found" }, { status: 404 });
  }

  const { data: blob, error: dlError } = await supabase.storage
    .from("documents")
    .download(statement.storage_path);
  if (dlError || !blob) {
    return NextResponse.json(
      { error: "Could not read the uploaded file. Nothing was changed." },
      { status: 500 }
    );
  }
  if (blob.size > MAX_PDF_BYTES) {
    return NextResponse.json({ error: "File too large" }, { status: 413 });
  }

  const mediaType = resolveMediaType(null, statement.file_name);
  const base64 = Buffer.from(await blob.arrayBuffer()).toString("base64");

  // 1. Read. Changes nothing.
  let parsed;
  try {
    parsed = await parseStatement({ base64, mediaType });
  } catch (e) {
    console.error("statement parsing failed:", e);
    return NextResponse.json(
      { error: "Reading the statement failed. Nothing was changed — try again." },
      { status: 502 }
    );
  }

  // 2. Validate against what we ALREADY hold. Changes nothing.
  const verdict = validateParsedStatement(parsed, {
    lineCount: Number(statement.txn_count ?? 0),
    reconciled: statement.totals_reconciled ?? null,
  });
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.reason }, { status: 422 });
  }

  // Link to a known card by last 4, if any.
  const last4 = /^\d{4}$/.test(parsed.card_last4 ?? "") ? parsed.card_last4 : null;
  let card_id: string | null = null;
  if (last4) {
    const { data: card } = await supabase
      .from("cards")
      .select("id")
      .eq("last4", last4)
      .limit(1)
      .maybeSingle();
    card_id = card?.id ?? null;
  }

  // Only what this reading actually found. Missing keys KEEP the existing
  // value (0025 coalesces), so a weaker re-parse never blanks a period.
  const header: Record<string, unknown> = {};
  if (parsed.period_start && ISO_DATE.test(parsed.period_start)) header.period_start = parsed.period_start;
  if (parsed.period_end && ISO_DATE.test(parsed.period_end)) header.period_end = parsed.period_end;
  if (card_id) header.card_id = card_id;
  if (parsed.previous_balance != null) header.previous_balance = parsed.previous_balance;
  if (parsed.total_purchases != null) header.total_purchases = parsed.total_purchases;
  if (parsed.total_payments != null) header.total_payments = parsed.total_payments;
  if (parsed.closing_balance != null) header.closing_balance = parsed.closing_balance;

  const lines = verdict.debits.map((t) => ({
    txn_date: t.date,
    description: t.description,
    amount: t.amount,
    // Validation guaranteed every line is in this one billing currency.
    currency: verdict.currency,
    card_last4: /^\d{4}$/.test(t.card_last4 ?? "") ? t.card_last4 : last4,
  }));

  // 3. Replace, atomically. On any error the existing lines are untouched.
  const { data: result, error: rpcError } = await supabase.rpc("replace_statement_lines", {
    p_statement_id: statementId,
    p_lines: lines,
    p_header: header,
    p_credits_excluded: verdict.creditsExcluded,
  });
  if (rpcError) {
    return NextResponse.json(
      { error: `Could not save the lines — nothing was changed. (${rpcError.message})` },
      { status: 500 }
    );
  }

  const r = result as { replaced: boolean; count: number; line_total: number };
  const lineTotal = Number(r.line_total);
  const printed = parsed.total_purchases;
  const reconciled = printed == null ? null : Math.abs(lineTotal - printed) <= 0.01;

  const message = !r.replaced
    ? "Kept the existing lines — this statement already has confirmed receipts. Its printed totals were updated."
    : reconciled === null
      ? `Read ${r.count} charges. This statement doesn't print a purchases total, so the app can't prove every line was captured.`
      : reconciled
        ? `Read ${r.count} charges totalling ${lineTotal.toFixed(2)} — matches the statement's own total exactly.`
        : `Read ${r.count} charges totalling ${lineTotal.toFixed(2)}, but the statement says ${Number(
            printed
          ).toFixed(2)}. Something was missed — check this statement before relying on it.`;

  return NextResponse.json({
    ok: true,
    replaced: r.replaced,
    count: r.count,
    creditsExcluded: verdict.creditsExcluded,
    totalPurchases: printed,
    lineTotal,
    reconciled,
    message,
  });
}
