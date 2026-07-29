import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { ExtractionResult } from "@/lib/types";
import { EXTRACTION_MODEL } from "@/lib/extraction/model";

const ExtractionSchema = z.object({
  doc_type: z.enum(["receipt", "invoice", "statement", "unknown"]),
  receipt_date: z
    .string()
    .nullable()
    .describe("Transaction date as YYYY-MM-DD, or null if not found"),
  vendor_name: z.string().nullable().describe("Merchant / vendor / supplier name"),
  amount: z.number().nullable().describe("Grand total amount paid"),
  currency: z
    .string()
    .nullable()
    .describe("ISO currency code, e.g. TTD or USD. Null if unclear."),
  usd_equivalent: z
    .number()
    .nullable()
    .describe(
      "If the document is in a currency other than TTD or USD but ALSO prints a USD figure for the same total, put that USD figure here. Null otherwise."
    ),
  tax_amount: z.number().nullable().describe("VAT / tax amount if shown"),
  payment_method: z.enum([
    "personal_card",
    "company_card",
    "cash",
    "online",
    "unknown",
    "other",
  ]),
  card_last4: z
    .string()
    .nullable()
    .describe("Last 4 digits of the card if visible, else null"),
  category_guess: z
    .string()
    .nullable()
    .describe("Best-guess expense category, e.g. Fuel, Food, Travel"),
  confidence: z.number().describe("Overall extraction confidence, 0-100"),
  notes: z.string().nullable().describe("Anything notable or uncertain"),
});

const PROMPT = `You are extracting structured data from a business expense document for a company in Trinidad & Tobago (local currency: TTD). Documents may be photos of receipts, scanned receipts, PDF invoices (often Amazon/online invoices in USD), or credit card statements.

Extract the requested fields. Rules:
- Use null for any field you cannot read confidently. Do not guess values.
- receipt_date must be YYYY-MM-DD. For statements, use the statement/closing date.
- amount is the final grand total actually paid (after tax).
- currency: the ISO code the grand total is actually billed in. Commonly TTD or USD, but regional invoices may be GYD (Guyana), BBD, XCD, JMD, CAD, GBP, EUR. Use the real code — never force it to TTD or USD.
- usd_equivalent: many regional invoices print a USD figure alongside the local total (e.g. "GYD 85,417.05 / USD 406.75", often with a stated rate like "1 USD = GYD 210.00"). When the currency is NOT TTD or USD and such a USD figure is shown, put it here — it is what lets the expense be valued. Leave null if no USD figure appears.
- card_last4: only if the digits are actually visible on the document.
- payment_method: infer from the document (card, cash, online). Use "unknown" if you cannot tell.
- category_guess: a short expense category such as Fuel, Food, Office supplies, Travel, Equipment, Online purchase, or Other.
- confidence: 0-100 reflecting how sure you are overall. Lower it when the image is blurry or fields are missing.`;

type ExtractInput = {
  base64: string;
  mediaType: string; // e.g. "image/jpeg" or "application/pdf"
  fileName?: string; // the user may type hints (e.g. card last 4) into the name
};

const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export async function extractDocument({
  base64,
  mediaType,
  fileName,
}: ExtractInput): Promise<ExtractionResult> {
  const client = new Anthropic();

  const fileNameHint = fileName
    ? `\n\nThe uploaded file is named: "${fileName}". Users often type useful hints into the file name — most commonly a card's last 4 digits, a vendor name, or a date. If the document itself doesn't clearly show one of these but the file name does, use the file name as the source for that field (especially card_last4).`
    : "";

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
            media_type: (IMAGE_TYPES.has(mediaType)
              ? mediaType
              : "image/jpeg") as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
            data: base64,
          },
        };

  const response = await client.messages.parse({
    model: EXTRACTION_MODEL,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [docBlock, { type: "text", text: PROMPT + fileNameHint }],
      },
    ],
    output_config: { format: zodOutputFormat(ExtractionSchema) },
  });

  const parsed = response.parsed_output;
  if (!parsed) {
    // Model refused or returned nothing parseable — treat as fully uncertain.
    return {
      doc_type: "unknown",
      receipt_date: null,
      vendor_name: null,
      amount: null,
      currency: null,
      usd_equivalent: null,
      tax_amount: null,
      payment_method: "unknown",
      card_last4: null,
      category_guess: null,
      confidence: 0,
      notes: "Could not extract document automatically.",
    };
  }

  return parsed;
}
