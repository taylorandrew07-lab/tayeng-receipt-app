import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { EXTRACTION_MODEL } from "@/lib/extraction/model";

const TxnSchema = z.object({
  date: z.string().nullable().describe("Transaction date as YYYY-MM-DD"),
  description: z.string().nullable().describe("Merchant / description text"),
  amount: z
    .number()
    .nullable()
    .describe("The value of the line as a POSITIVE number, whichever direction it is"),
  /**
   * The direction check. Andrew only ever uploads CREDIT CARD statements, so a
   * PAYMENT line is always a payment TO the card and never an expense needing a
   * receipt. Capturing direction explicitly means a chequing/current account
   * statement — where the same words mean the opposite — cannot be silently
   * misread as a pile of expenses if one is ever uploaded.
   */
  direction: z
    .enum(["debit", "credit"])
    .describe(
      "debit = money spent or charged to the account (purchase, fee, interest). " +
        "credit = money coming back (payment to the card, refund, reversal)."
    ),
  currency: z.string().nullable().describe("ISO currency, usually TTD"),
  card_last4: z.string().nullable().describe("Card last 4 if shown per line"),
});

const StatementSchema = z.object({
  /**
   * Guards against a non-credit-card document being parsed with credit-card
   * assumptions. Anything but `credit_card` means the direction of every line
   * is not what the rest of this system expects.
   */
  document_kind: z
    .enum(["credit_card", "bank_account", "other"])
    .describe(
      "credit_card for a credit card statement; bank_account for a chequing/savings/current " +
        "account statement; other for anything else."
    ),
  card_last4: z.string().nullable().describe("Statement's card last 4 digits, if shown"),
  period_start: z.string().nullable().describe("Statement period start YYYY-MM-DD"),
  period_end: z.string().nullable().describe("Statement period end / closing date YYYY-MM-DD"),

  // --- The control totals, as PRINTED in the statement's own summary --------
  previous_balance: z
    .number()
    .nullable()
    .describe("Opening / previous balance from the summary box, as printed"),
  total_purchases: z
    .number()
    .nullable()
    .describe(
      "The statement's own printed TOTAL of purchases/debits for the period, INCLUDING fees " +
        "and interest. Positive. Null only if the statement genuinely does not print one."
    ),
  total_payments: z
    .number()
    .nullable()
    .describe("The printed total of payments and credits for the period. Positive."),
  closing_balance: z
    .number()
    .nullable()
    .describe("Closing / new balance from the summary box, as printed"),

  transactions: z.array(TxnSchema),
});

export type ParsedStatement = z.infer<typeof StatementSchema>;
export type ParsedTransaction = z.infer<typeof TxnSchema>;

/**
 * EVERY line, and the statement's own arithmetic.
 *
 * The previous prompt told the model to EXCLUDE fees and interest. That
 * directly contradicted the database, which since 0015 has had a whole
 * is_fee_description() layer whose job is to classify exactly those lines as
 * "no receipt expected" — and 0020 exists only because real fee lines came
 * through anyway. So which lines survived was left to model whim, and no total
 * could ever be checked.
 *
 * The rule now: extract everything, let the database decide what is chaseable.
 * Dropping a line is the one thing this system must never do silently.
 */
const PROMPT = `You are reading a credit card statement for a company in Trinidad & Tobago (currency TTD).

Extract EVERY transaction line, and the statement's own summary totals.

Transactions:
- Include EVERY line in the transaction list: purchases, fees, interest, finance charges, payments to the card, refunds and reversals. Do NOT leave anything out and do NOT summarise.
- amount is always a POSITIVE number. Use "direction" to say which way the money went:
    direction = "debit"  for money spent or charged (purchases, fees, interest, finance charges)
    direction = "credit" for money coming back (payments to the card, refunds, reversals)
- date must be YYYY-MM-DD. If both a transaction date and a posting date are shown, use the transaction date.
- description: the merchant/description text exactly as printed.
- card_last4: only if the statement shows a per-line card number; otherwise null.

Summary totals — read these from the statement's own summary box, exactly as printed:
- previous_balance, total_purchases, total_payments, closing_balance.
- total_purchases must be the statement's printed total of purchases/debits for the period INCLUDING fees and interest. If the statement prints purchases and fees as separate totals, add them together.
- If a figure is genuinely not printed anywhere, return null for it. Do NOT calculate or estimate it yourself — a guessed total is worse than no total, because it will be used to check our own work.

document_kind: "credit_card" for a credit card statement, "bank_account" for a chequing/savings/current account statement, "other" for anything else.

If the document is not a statement at all, return an empty transactions array.`;

export async function parseStatement({
  base64,
  mediaType,
}: {
  base64: string;
  mediaType: string;
}): Promise<ParsedStatement> {
  const client = new Anthropic();

  const docBlock: Anthropic.ContentBlockParam =
    mediaType === "application/pdf"
      ? {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: base64 },
        }
      : {
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType === "image/png" ? "image/png" : "image/jpeg",
            data: base64,
          },
        };

  const response = await client.messages.parse({
    model: EXTRACTION_MODEL,
    max_tokens: 16000,
    messages: [{ role: "user", content: [docBlock, { type: "text", text: PROMPT }] }],
    output_config: { format: zodOutputFormat(StatementSchema) },
  });

  return (
    response.parsed_output ?? {
      document_kind: "other",
      card_last4: null,
      period_start: null,
      period_end: null,
      previous_balance: null,
      total_purchases: null,
      total_payments: null,
      closing_balance: null,
      transactions: [],
    }
  );
}
