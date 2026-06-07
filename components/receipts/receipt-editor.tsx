"use client";

import { useActionState } from "react";
import { saveReceipt, deleteReceipt, type ReceiptFormState } from "@/lib/receipts/actions";
import type { Card, Category, Receipt } from "@/lib/types";

const PAYMENT_OPTIONS: { value: string; label: string }[] = [
  { value: "personal_card", label: "Personal card (reimbursable)" },
  { value: "company_card", label: "Company card (accounting only)" },
  { value: "cash", label: "Cash (reimbursable)" },
  { value: "online", label: "Online / Amazon" },
  { value: "unknown", label: "Unknown" },
  { value: "other", label: "Other" },
];

export function ReceiptEditor({
  receipt,
  cards,
  categories,
}: {
  receipt: Receipt;
  cards: Card[];
  categories: Category[];
}) {
  const [state, action, pending] = useActionState<ReceiptFormState, FormData>(
    saveReceipt,
    undefined
  );

  const reimb =
    receipt.reimbursable === true
      ? "yes"
      : receipt.reimbursable === false
        ? "no"
        : "";

  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="id" value={receipt.id} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Vendor">
          <input
            name="vendor_name"
            defaultValue={receipt.vendor_name ?? ""}
            className={inputCls}
          />
        </Field>
        <Field label="Date">
          <input
            type="date"
            name="receipt_date"
            defaultValue={receipt.receipt_date ?? ""}
            className={inputCls}
          />
        </Field>

        <Field label="Category">
          <select
            name="category_id"
            defaultValue={receipt.category_id ?? ""}
            className={inputCls}
          >
            <option value="">— Choose —</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Payment method">
          <select
            name="payment_method"
            defaultValue={receipt.payment_method}
            className={inputCls}
          >
            {PAYMENT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Card">
          <select name="card_id" defaultValue={receipt.card_id ?? ""} className={inputCls}>
            <option value="">— None —</option>
            {cards.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nickname}
                {c.last4 ? ` ••${c.last4}` : ""}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Card last 4 (if visible)">
          <input
            name="card_last4"
            inputMode="numeric"
            maxLength={4}
            defaultValue={receipt.card_last4 ?? ""}
            className={inputCls}
          />
        </Field>

        <Field label="Currency">
          <input
            name="currency"
            defaultValue={receipt.currency ?? "TTD"}
            className={inputCls}
          />
        </Field>
        <Field label="Original amount">
          <input
            name="amount"
            inputMode="decimal"
            defaultValue={receipt.amount != null ? String(receipt.amount) : ""}
            className={inputCls}
          />
        </Field>

        <Field label="TTD equivalent">
          <input
            name="ttd_amount"
            inputMode="decimal"
            defaultValue={receipt.ttd_amount != null ? String(receipt.ttd_amount) : ""}
            className={inputCls}
          />
        </Field>
        <Field label="Tax / VAT">
          <input
            name="tax_amount"
            inputMode="decimal"
            defaultValue={receipt.tax_amount != null ? String(receipt.tax_amount) : ""}
            className={inputCls}
          />
        </Field>

        <Field label="Reimbursable">
          <select name="reimbursable" defaultValue={reimb} className={inputCls}>
            <option value="">— Not decided —</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </Field>
      </div>

      <Field label="Notes">
        <textarea
          name="notes"
          rows={2}
          defaultValue={receipt.notes ?? ""}
          className={inputCls}
        />
      </Field>

      {state?.error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      )}

      <div className="flex items-center justify-between gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save & confirm"}
        </button>

        <button
          type="submit"
          formAction={deleteReceipt}
          formNoValidate
          onClick={(e) => {
            if (!window.confirm("Delete this receipt? This cannot be undone."))
              e.preventDefault();
          }}
          className="text-sm text-slate-400 hover:text-red-700"
        >
          Delete receipt
        </button>
      </div>
    </form>
  );
}

const inputCls =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      {children}
    </label>
  );
}
