import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import { loadCloseOut } from "@/lib/reconciliation/board-data";
import { PairingBoard } from "@/components/reconcile/pairing-board";

export const dynamic = "force-dynamic";

export default async function BoardPage() {
  const supabase = await createClient();
  const d = await loadCloseOut(supabase);

  // Both sides of the gap: charges still wanting a receipt, and receipts that
  // sit on no statement. Suggested-but-unconfirmed charges are included so a
  // weak suggestion can be overridden by hand here.
  const charges = [...d.needsReceipt, ...d.needsConfirmation].map((c) => ({
    charge_id: c.charge_id,
    canonical_txn_id: c.canonical_txn_id,
    txn_date: c.txn_date,
    description: c.description,
    amount: c.amount,
    currency: c.currency,
    copies: c.copies,
  }));

  const receipts = d.orphansOpen.concat(d.orphansSent).map((o) => ({
    receipt_id: o.receipt_id,
    receipt_date: o.receipt_date,
    vendor_name: o.vendor_name,
    ttd_amount: o.ttd_amount,
    currency: o.currency,
    sent: o.sent,
  }));

  return (
    <div>
      <PageHeader
        title="Match them up"
        subtitle={`${charges.length} charges without a receipt · ${receipts.length} receipts without a charge`}
        action={
          <Link
            href="/reconcile"
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
          >
            Back to Close-Out
          </Link>
        }
      />
      <PairingBoard charges={charges} receipts={receipts} />
    </div>
  );
}
