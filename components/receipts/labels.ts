import type { PaymentMethod, ReceiptStatus } from "@/lib/types";

export const PAYMENT_LABEL: Record<PaymentMethod, string> = {
  personal_card: "Personal card",
  company_card: "Company card",
  cash: "Cash",
  online: "Online",
  unknown: "Unknown",
  other: "Other",
};

export const STATUS_BADGE: Record<ReceiptStatus, string> = {
  processing: "bg-blue-100 text-blue-800",
  needs_review: "bg-amber-100 text-amber-800",
  confirmed: "bg-green-100 text-green-800",
};

export const STATUS_LABEL: Record<ReceiptStatus, string> = {
  processing: "Processing",
  needs_review: "Needs review",
  confirmed: "Confirmed",
};
