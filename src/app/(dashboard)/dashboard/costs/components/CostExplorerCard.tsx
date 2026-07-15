// Extracted from CostOverviewTab.tsx (#7213 file-size ratchet) — no behavior change, verbatim move.
import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { Card, EmptyState, SegmentedControl } from "@/shared/components";
import { createCurrencyFormatter, formatCurrencyCost } from "../costFormatters";
import type {
  CostExplorerGroupBy,
  CostExplorerRow,
  CostExplorerSortDirection,
  CostExplorerSortKey,
} from "../costExplorerUtils";

export function CostExplorerCard({
  rows,
  totalRows,
  groupBy,
  groupOptions,
  searchQuery,
  sortKey,
  sortDirection,
  locale,
  hasCostData,
  onGroupByChange,
  onSearchChange,
  onSort,
}: {
  rows: CostExplorerRow[];
  totalRows: number;
  groupBy: CostExplorerGroupBy;
  groupOptions: Array<{ value: CostExplorerGroupBy; label: string }>;
  searchQuery: string;
  sortKey: CostExplorerSortKey;
  sortDirection: CostExplorerSortDirection;
  locale: string;
  hasCostData: boolean;
  onGroupByChange: (groupBy: CostExplorerGroupBy) => void;
  onSearchChange: (query: string) => void;
  onSort: (sortKey: CostExplorerSortKey) => void;
}) {
  const t = useTranslations("costs");
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const compactFormatter = useMemo(
    () => new Intl.NumberFormat(locale, { notation: "compact" }),
    [locale]
  );
  const currencyFormatter = useMemo(() => createCurrencyFormatter(locale), [locale]);

  const columns = useMemo<
    Array<{
      key: CostExplorerSortKey;
      label: string;
      align: "left" | "right";
    }>
  >(
    () => [
      { key: "name", label: t("dimension"), align: "left" },
      { key: "cost", label: t("cost"), align: "right" },
      { key: "requests", label: t("requests"), align: "right" },
      { key: "totalTokens", label: t("tokens"), align: "right" },
      { key: "avgCostPerRequest", label: t("avgCostPerRequest"), align: "right" },
      { key: "sharePct", label: t("share"), align: "right" },
    ],
    [t]
  );

  function renderSortIcon(columnKey: CostExplorerSortKey) {
    if (sortKey !== columnKey) return "unfold_more";
    return sortDirection === "asc" ? "arrow_upward" : "arrow_downward";
  }

  function formatCost(value: number): string {
    if (!hasCostData && value <= 0) return t("legacyOrFree");
    return formatCurrencyCost(locale, value);
  }

  function formatRowCount(): string {
    const shown = numberFormatter.format(rows.length);
    const total = numberFormatter.format(totalRows);
    if (totalRows > rows.length) {
      return t("showingTopCostRows", { shown, total });
    }

    return t("showingCostRows", { shown, total });
  }

  return (
    <Card className="p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between mb-5">
        <div>
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-emerald-400 text-xl">
              travel_explore
            </span>
            <h3 className="text-lg font-bold text-text-main">{t("costExplorerTitle")}</h3>
          </div>
          <p className="text-sm text-text-muted mt-1">{t("costExplorerDescription")}</p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <SegmentedControl
            options={groupOptions}
            value={groupBy}
            onChange={(value) => onGroupByChange(value as CostExplorerGroupBy)}
          />
          <label className="relative block min-w-55">
            <span className="material-symbols-outlined pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-text-muted">
              search
            </span>
            <input
              value={searchQuery}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder={t("filterRows")}
              className="w-full rounded-lg border border-border/40 bg-surface/40 py-2 pl-9 pr-3 text-sm text-text-main placeholder:text-text-muted focus:border-primary focus:outline-none"
              aria-label={t("filterCostExplorerRows")}
            />
          </label>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-border/30 bg-surface/20 p-6">
          <EmptyState
            icon="manage_search"
            title={t("noMatchingCostRows")}
            description={t("noMatchingCostRowsDescription")}
          />
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-205 text-sm">
              <thead>
                <tr className="border-b border-border/30 text-[11px] uppercase text-text-muted">
                  {columns.map((column) => (
                    <th
                      key={column.key}
                      className={`pb-2 font-semibold ${
                        column.align === "right" ? "text-right" : "text-left"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => onSort(column.key)}
                        className={`inline-flex items-center gap-1 hover:text-text-main ${
                          column.align === "right" ? "justify-end" : "justify-start"
                        }`}
                      >
                        <span>{column.label}</span>
                        <span className="material-symbols-outlined text-sm">
                          {renderSortIcon(column.key)}
                        </span>
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/20">
                {rows.map((row) => (
                  <tr key={row.id} className="hover:bg-surface/20">
                    <td className="py-3 pr-4">
                      <div className="flex flex-col">
                        <span className="font-medium text-text-main">{row.name}</span>
                        {row.detail ? (
                          <span className="text-xs text-text-muted truncate max-w-[320px]">
                            {row.detail}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="py-3 text-right font-mono text-text-muted">
                      {formatCost(row.cost)}
                    </td>
                    <td className="py-3 text-right font-mono text-text-muted">
                      {numberFormatter.format(row.requests)}
                    </td>
                    <td className="py-3 text-right font-mono text-text-muted">
                      {compactFormatter.format(row.totalTokens)}
                    </td>
                    <td className="py-3 text-right font-mono text-text-muted">
                      {row.avgCostPerRequest > 0
                        ? currencyFormatter.format(row.avgCostPerRequest)
                        : "—"}
                    </td>
                    <td className="py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <div className="h-1.5 w-16 overflow-hidden rounded-full bg-surface/60">
                          <div
                            className="h-full rounded-full bg-emerald-400"
                            style={{ width: `${Math.min(Math.max(row.sharePct, 0), 100)}%` }}
                          />
                        </div>
                        <span className="w-12 font-mono text-text-muted">
                          {row.sharePct.toFixed(1)}%
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-text-muted">{formatRowCount()}</p>
        </>
      )}
    </Card>
  );
}
