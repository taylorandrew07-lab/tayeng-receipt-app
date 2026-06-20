import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import { CardForm } from "@/components/cards/card-form";
import { DeleteButton } from "@/components/delete-button";
import { deleteCard } from "@/lib/cards/actions";
import type { Card, CardType } from "@/lib/types";

const TYPE_LABEL: Record<CardType, string> = {
  personal: "Personal — reimbursable",
  company: "Company — accounting only",
  cash: "Cash",
  other: "Other",
};

const TYPE_BADGE: Record<CardType, string> = {
  personal: "bg-green-100 text-green-800",
  company: "bg-blue-100 text-blue-800",
  cash: "bg-amber-100 text-amber-800",
  other: "bg-slate-100 text-slate-700",
};

export default async function CardsPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("cards")
    .select("*")
    .order("created_at", { ascending: true });

  const cards = (data ?? []) as Card[];

  return (
    <div>
      <PageHeader
        title="Cards & payments"
        subtitle="Define your cards so the app can classify receipts automatically. Personal cards and cash are reimbursable; company cards are accounting-only."
      />

      <div className="mb-8">
        <CardForm />
      </div>

      <h2 className="mb-3 font-semibold text-slate-900">Your cards</h2>
      {cards.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          No cards yet. Add your first card above.
        </div>
      ) : (
        <ul className="space-y-3">
          {cards.map((card) => (
            <li
              key={card.id}
              className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-slate-900 truncate">
                    {card.nickname}
                  </span>
                  {card.last4 && (
                    <span className="text-sm text-slate-400">
                      •••• {card.last4}
                    </span>
                  )}
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${TYPE_BADGE[card.card_type]}`}
                  >
                    {TYPE_LABEL[card.card_type]}
                  </span>
                  {card.notes && (
                    <span className="text-xs text-slate-400 truncate">
                      {card.notes}
                    </span>
                  )}
                </div>
              </div>

              <DeleteButton
                action={deleteCard}
                id={card.id}
                label="Remove"
                confirmText={`Remove the card "${card.nickname}"? Receipts already classified to it are not affected.`}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
