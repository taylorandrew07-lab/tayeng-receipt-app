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
- currency: detect TTD vs USD (Amazon and most online invoices are USD). Null if genuinely unclear.
- card_last4: only if the digits are actually visible on the document.
- payment_method: infer from the document (card, cash, online). Use "unknown" if you cannot tell.
- category_guess: a short expense category such as Fuel, Food, Office supplies, Travel, Equipment, Online purchase, or Other.
- confidence: 0-100 reflecting how sure you are overall. Lower it when the image is blurry or fields are missing.`;

type ExtractInput = {
  base64: string;
  mediaType: string; // e.g. "image/jpeg" or "application/pdf"
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
}: ExtractInput): Promise<ExtractionResult> {
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
        content: [docBlock, { type: "text", text: PROMPT }],
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
