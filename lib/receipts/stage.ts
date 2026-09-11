import { NEVER_ON_A_CARD_STATEMENT } from "@/lib/matching/eligibility";

/**
 * Where a receipt is in its life — ONE label that answers the question Andrew
 * is actually asking when he looks at it.
 *
 * The list used to show the extraction status: "Confirmed" for everything past
 * review. That word covered "matched and ready to send", "still waiting for a
 * statement to turn up", "sent last month" and "paid back" alike — so a phone
 * screen full of green "Confirmed" badges said nothing about what was left to
 * do. Sent and paid were extra badges beside it, and "matched" was not shown
 * at all.
 *
 * Pure, so every stage is unit-tested.
 */
export type StageTone = "info" | "warn" | "todo" | "ready" | "done";

export type Stage = { label: string; tone: StageTone };

export type StageInput = {
  status: "processing" | "needs_review" | "confirmed";
  duplicate_of: string | null;
  payment_method: string;
  sent: boolean;
  paid: boolean;
};

export function receiptStage(r: StageInput, matchedToCharge: boolean): Stage {
  if (r.status === "processing") return { label: "Reading…", tone: "info" };
  if (r.duplicate_of) return { label: "Possible duplicate", tone: "warn" };
  if (r.status === "needs_review") return { label: "Needs review", tone: "warn" };

  // Paid yourself: settled through the reimbursable claim, never a statement.
  if ((NEVER_ON_A_CARD_STATEMENT as readonly string[]).includes(r.payment_method)) {
    if (r.paid) return { label: "Paid back", tone: "done" };
    if (r.sent) return { label: "Claimed · awaiting payment", tone: "info" };
    return { label: "Ready to claim", tone: "ready" };
  }

  // Expected on the company card statement.
  if (r.sent) return { label: "Sent to accountant", tone: "done" };
  if (matchedToCharge) return { label: "Matched · ready to send", tone: "ready" };
  return { label: "Waiting for a statement line", tone: "todo" };
}

export const STAGE_BADGE: Record<StageTone, string> = {
  info: "bg-blue-100 text-blue-800",
  warn: "bg-amber-100 text-amber-800",
  todo: "bg-slate-100 text-slate-700",
  ready: "bg-emerald-100 text-emerald-800",
  done: "bg-slate-200 text-slate-600",
};
