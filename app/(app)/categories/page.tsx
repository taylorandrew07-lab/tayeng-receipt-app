import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import { CategoryForm } from "@/components/categories/category-form";
import { deleteCategory } from "@/lib/categories/actions";
import type { Category } from "@/lib/types";

export default async function CategoriesPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("categories")
    .select("*")
    .order("name", { ascending: true });

  const categories = (data ?? []) as Category[];

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Categories"
        subtitle="Expense categories used to organise receipts. We added a starter set — add your own anytime."
      />

      <div className="mb-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <CategoryForm />
      </div>

      <ul className="space-y-2">
        {categories.map((cat) => (
          <li
            key={cat.id}
            className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm"
          >
            <span className="text-sm font-medium text-slate-900">
              {cat.name}
              {cat.is_default && (
                <span className="ml-2 text-xs font-normal text-slate-400">
                  default
                </span>
              )}
            </span>
            <form action={deleteCategory}>
              <input type="hidden" name="id" value={cat.id} />
              <button
                type="submit"
                className="text-sm text-slate-400 hover:text-red-700"
              >
                Remove
              </button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  );
}
