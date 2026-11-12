"use client";

import { FileUp } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { CsvResult } from "@/lib/types";

/**
 * Orders from a spreadsheet. The file is checked first (dry run); nothing is
 * imported until Import is pressed, and a file with a bad row is not half-imported.
 */
export function CsvUpload({ orgUrl, storeId: fixedStore, onImported }: { orgUrl: string; storeId?: string; onImported?: () => void }) {
  const mutation = useMutation({
    mutationFn: async ({ action }: { action: () => Promise<unknown>; done?: string }) => action(),
    onSuccess: (_r, { done }) => {
      if (done) toast.success(done);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : String(err)),
  });
  const run = <T,>(action: () => Promise<T>, done?: string) => mutation.mutateAsync({ action, done }).catch(() => undefined) as Promise<T | undefined>;
  const pending = mutation.isPending;
  const inputId = useId();
  const [file, setFile] = useState<{ name: string; csv: string; storeId: string; result: CsvResult } | null>(null);

  const storeForCsv = async () => {
    if (fixedStore) return fixedStore;
    const stores = await api.get<Array<{ id: string; kind: string }>>(`${orgUrl}/stores`);
    const found = stores.find((s) => s.kind === "csv") ?? stores[0];
    if (found) return found.id;
    return (await api.post<{ id: string }>(`${orgUrl}/stores`, { name: "Spreadsheet upload", kind: "csv" })).id;
  };

  const pick = async (f: File | undefined) => {
    if (!f) return;
    const csv = await f.text();
    const checked = await run(async () => {
      const storeId = await storeForCsv();
      const result = await api.post<CsvResult>(`${orgUrl}/stores/${storeId}/orders/csv`, { csv, dryRun: true });
      return { storeId, result };
    });
    if (checked) setFile({ name: f.name, csv, ...checked });
  };

  const importNow = async () => {
    if (!file) return;
    const result = await run(
      () => api.post<CsvResult>(`${orgUrl}/stores/${file.storeId}/orders/csv`, { csv: file.csv, dryRun: false }),
      "Orders imported. Run the match again to include them.",
    );
    if (result) {
      setFile({ ...file, csv: "", result });
      onImported?.();
    }
  };

  const r = file?.result;
  return (
    <details className="group rounded-xl border bg-card p-5 open:pb-5" data-testid="csv-upload">
      <summary className="flex cursor-pointer list-none items-center gap-2 font-semibold">
        <FileUp className="size-4 text-primary" aria-hidden /> Add orders from a spreadsheet (CSV)
      </summary>
      <p className="mt-3 text-sm text-muted-foreground">
        One row per order line. Required columns: order_number, placed_at, currency, title, quantity, unit_price. Add sku, batch_code, shipped_at,
        customer_email and paypal_payment_id where you have them: they are what the match uses.
      </p>
      <label htmlFor={inputId} className="mt-3 block text-sm font-medium">
        Order file
      </label>
      <input
        id={inputId}
        type="file"
        accept=".csv,text/csv"
        className="mt-1 block text-sm file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm"
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      {r ? (
        <div className="mt-4 flex flex-col gap-2 text-sm" role="status" data-testid="csv-result">
          <p>
            {file!.name}: {r.rows} rows, {r.orders} orders
            {r.imported ? `, imported (${r.created} new, ${r.updated} updated, ${r.links.exact} linked to a PayPal payment)` : ""}
          </p>
          {r.errors.length > 0 ? (
            <>
              <ul className="list-disc pl-5 text-destructive">
                {r.errors.slice(0, 10).map((x) => (
                  <li key={x.row + x.message}>
                    Row {x.row}: {x.message}
                  </li>
                ))}
              </ul>
              <p>Fix these rows and choose the file again. Nothing was imported.</p>
            </>
          ) : null}
          {!r.imported && r.errors.length === 0 && r.orders > 0 ? (
            <Button size="sm" className="w-fit" onClick={() => void importNow()} disabled={pending}>
              Import {r.orders} orders
            </Button>
          ) : null}
          {r.warnings.length > 0 ? <p className="text-muted-foreground">{r.warnings.slice(0, 5).join(" ")}</p> : null}
        </div>
      ) : null}
    </details>
  );
}
