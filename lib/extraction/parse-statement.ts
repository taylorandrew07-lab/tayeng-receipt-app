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
    .describe("Charge amount as a positive number; ignore payments/credits"),
  currency: z.string().nullable().describe("ISO currency, usually TTD"),
  card_last4: z.string().nullable().describe("Card last 4 if shown per line"),
});

const StatementSchema = z.object({
  card_last4: z
    .string()
    .nullable()
    .describe("Statement's card last 4 digits, if shown"),
  period_start: z.string().nullable().describe("Statement period start YYYY-MM-DD"),
  period_end: z.string().nullable().describe("Statement period end / closing date YYYY-MM-DD"),
  transactions: z.array(TxnSchema),
});

export type ParsedStatement = z.infer<typeof StatementSchema>;
export type ParsedTransaction = z.infer<typeof TxnSchema>;

const PROMPT = `You are reading a credit card statement for a company in Trinidad & Tobago (currency TTD). Extract every purchase/charge transaction.

Rules:
- Only include purchases/charges (money spent). EXCLUDE payments to the card, refunds, credits, interest, and fees unless they are clearly purchases.
- amount must be a positive number (the charge value as shown, normally already converted to TTD).
- date must be YYYY-MM-DD. If only a transaction date and a posting date exist, use the transaction date.
- description: the merchant/description text exactly as printed.
- card_last4: include only if the statement shows a per-line card number; otherwise null.
- Also return the statement's card_last4 and the statement period start/end if visible.
- If the document is not actually a statement, return an empty transactions array.`;

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
    max_tokens: 8000,
    messages: [
      { role: "user", content: [docBlock, { type: "text", text: PROMPT }] },
    ],
    output_config: { format: zodOutputFormat(StatementSchema) },
  });

  return (
    response.parsed_output ?? {
      card_last4: null,
      period_start: null,
      period_end: null,
      transactions: [],
    }
  );
}
