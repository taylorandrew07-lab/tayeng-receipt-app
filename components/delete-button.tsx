"use client";

/**
 * Submits a server action to delete something, after a confirm() prompt so the
 * user can't delete by accident. The server action is passed in as a prop.
 */
export function DeleteButton({
  action,
  id,
  idName = "id",
  label = "Delete",
  confirmText = "Delete this permanently? This cannot be undone.",
  className = "rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-red-50 hover:text-red-700",
}: {
  action: (formData: FormData) => void | Promise<void>;
  id: string;
  idName?: string;
  label?: string;
  confirmText?: string;
  className?: string;
}) {
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(confirmText)) e.preventDefault();
      }}
    >
      <input type="hidden" name={idName} value={id} />
      <button type="submit" className={className}>
        {label}
      </button>
    </form>
  );
}
