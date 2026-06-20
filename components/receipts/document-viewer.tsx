"use client";

import { useState } from "react";

/**
 * Receipt preview with zoom + rotate controls (images) so the user can read
 * faint or sideways photos without leaving the page. PDFs open in a new tab.
 */
export function DocumentViewer({
  fileUrl,
  fileName,
  isPdf,
}: {
  fileUrl: string | null;
  fileName: string | null;
  isPdf: boolean;
}) {
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-slate-700">Original document</p>
        {fileUrl && !isPdf && (
          <div className="flex items-center gap-1">
            <ToolButton
              label="Zoom out"
              onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.25) * 100) / 100))}
            >
              −
            </ToolButton>
            <ToolButton label="Zoom in" onClick={() => setZoom((z) => Math.min(4, z + 0.25))}>
              +
            </ToolButton>
            <ToolButton label="Rotate" onClick={() => setRotation((r) => (r + 90) % 360)}>
              ⟳
            </ToolButton>
            {(zoom !== 1 || rotation !== 0) && (
              <ToolButton
                label="Reset"
                onClick={() => {
                  setZoom(1);
                  setRotation(0);
                }}
              >
                ⤺
              </ToolButton>
            )}
          </div>
        )}
      </div>

      {fileName && (
        <p className="mb-3 mt-0.5 truncate text-xs text-slate-500">📎 {fileName}</p>
      )}

      {!fileUrl ? (
        <p className="text-sm text-slate-500">No file attached.</p>
      ) : isPdf ? (
        <a
          href={fileUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="block rounded-lg border border-slate-200 bg-slate-50 p-6 text-center text-sm font-medium text-slate-700 hover:bg-slate-100"
        >
          📄 Open PDF
        </a>
      ) : (
        <div className="max-h-[70vh] overflow-auto rounded-lg border border-slate-200 bg-slate-50">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={fileUrl}
            alt="Receipt"
            style={{
              transform: `rotate(${rotation}deg) scale(${zoom})`,
              transformOrigin: "center",
            }}
            className="mx-auto block w-full origin-center transition-transform duration-150"
          />
        </div>
      )}
      {fileUrl && !isPdf && (
        <a
          href={fileUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-block text-xs font-medium text-slate-500 underline hover:text-slate-700"
        >
          Open full size in new tab
        </a>
      )}
    </div>
  );
}

function ToolButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-300 text-slate-700 hover:bg-slate-100 active:scale-95"
    >
      {children}
    </button>
  );
}
