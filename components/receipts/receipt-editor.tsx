"use client";

import { useActionState, useState } from "react";
import { saveReceipt, deleteReceipt, type ReceiptFormState } from "@/lib/receipts/actions";
import type { Card, Category, PaymentMethod, Receipt } from "@/lib/types";

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
  const [payment, setPayment] = useState<PaymentMethod>(receipt.payment_method);
  const reimbursable = payment !== "company_card";
  const [cardLast4, setCardLast4] = useState(receipt.card_last4 ?? "");
  const [billBack, setBillBack] = useState(receipt.bill_back);
  const [billBackType, setBillBackType] = useState<"client" | "vessel">(
    receipt.bill_back_type ?? "client"
  );
  const [billBackName, setBillBackName] = useState(receipt.bill_back_name ?? "");
  const is4881 = cardLast4 === "4881";

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
            value={payment}
            onChange={(e) => setPayment(e.target.value as PaymentMethod)}
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
            value={cardLast4}
            onChange={(e) => setCardLast4(e.target.value.replace(/\D/g, ""))}
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

        <Field label="Reimbursable (automatic)">
          <div
            className={`flex h-[38px] items-center rounded-lg border px-3 text-sm font-medium ${
              reimbursable
                ? "border-green-200 bg-green-50 text-green-800"
                : "border-blue-200 bg-blue-50 text-blue-800"
            }`}
          >
            {reimbursable ? "Yes — reimbursable" : "No — company card"}
          </div>
        </Field>
      </div>

      {/* Bill-back: charge this expense back to a client or vessel. */}
      <div
        className={`rounded-xl border p-4 ${
          billBack
            ? "border-purple-300 bg-purple-50"
            : is4881
              ? "border-purple-300 bg-purple-50/40"
              : "border-slate-200 bg-slate-50"
        }`}
      >
        <input type="hidden" name="bill_back" value={billBack ? "yes" : "no"} />
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">
              Bill back to a client / vessel?
            </p>
            {is4881 && !billBack && (
              <p className="mt-0.5 text-xs font-medium text-purple-700">
                This is the company card ending 4881 — mark it if it should be billed back.
              </p>
            )}
          </div>
          <div className="flex overflow-hidden rounded-lg border border-slate-300 text-sm">
            <button
              type="button"
              onClick={() => setBillBack(false)}
              className={`px-3 py-1.5 font-medium ${
                !billBack ? "bg-slate-900 text-white" : "bg-white text-slate-600"
              }`}
            >
              No
            </button>
            <button
              type="button"
              onClick={() => setBillBack(true)}
              className={`px-3 py-1.5 font-medium ${
                billBack ? "bg-purple-700 text-white" : "bg-white text-slate-600"
              }`}
            >
              Yes
            </button>
          </div>
        </div>

        {billBack && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Type">
              <select
                name="bill_back_type"
                value={billBackType}
                onChange={(e) => setBillBackType(e.target.value as "client" | "vessel")}
                className={inputCls}
              >
                <option value="client">Client</option>
                <option value="vessel">Vessel</option>
              </select>
            </Field>
            <Field label={billBackType === "vessel" ? "Vessel name" : "Client name"}>
              <input
                name="bill_back_name"
                value={billBackName}
                onChange={(e) => setBillBackName(e.target.value)}
                placeholder={billBackType === "vessel" ? "e.g. MV Caribbean Star" : "e.g. ABC Ltd"}
                className={inputCls}
              />
            </Field>
          </div>
        )}
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
          className="rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
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
