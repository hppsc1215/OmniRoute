// Extracted from CostOverviewTab.tsx (#7213 file-size ratchet) — no behavior change, verbatim move.
import { Card } from "@/shared/components";
import { createCurrencyFormatter } from "../costFormatters";

export interface ColumnDef {
  key: string;
  label: string;
  align: "left" | "right";
  format?: "number" | "compact" | "currency";
}

export function CostBreakdownTable({
  title,
  rows,
  columns,
  locale,
  legacyFreeLabel,
}: {
  title: string;
  rows: Array<Record<string, any>>;
  columns: ColumnDef[];
  locale: string;
  legacyFreeLabel: string;
}) {
  const currencyFormatter = createCurrencyFormatter(locale);

  function formatValue(value: unknown, format?: ColumnDef["format"]): string {
    const num = Number(value || 0);
    switch (format) {
      case "currency":
        return num > 0 ? currencyFormatter.format(num) : legacyFreeLabel;
      case "compact":
        return new Intl.NumberFormat(locale, { notation: "compact" }).format(num);
      case "number":
        return new Intl.NumberFormat(locale).format(num);
      default:
        return String(value ?? "-");
    }
  }

  return (
    <Card className="p-5">
      <h3 className="text-sm font-semibold text-text-muted uppercase tracking-wide mb-4">
        {title}
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] text-text-muted uppercase border-b border-border/30">
              {columns.map((column) => (
                <th
                  key={column.key}
                  className={`pb-2 font-semibold ${
                    column.align === "right" ? "text-right" : "text-left"
                  }`}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/20">
            {rows.map((row) => (
              <tr key={String(row[columns[0].key])} className="hover:bg-surface/20">
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={`py-2 ${
                      column.align === "right"
                        ? "text-right font-mono text-text-muted"
                        : "text-left text-text-main truncate max-w-50"
                    }`}
                  >
                    {formatValue(row[column.key], column.format)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
