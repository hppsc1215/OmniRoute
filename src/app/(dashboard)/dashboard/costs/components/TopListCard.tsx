// Extracted from CostOverviewTab.tsx (#7213 file-size ratchet) — no behavior change, verbatim move.
// NOTE: the `t("legacyFreeLabel")` reference below has no enclosing translation hook — this is a
// pre-existing bug on the base branch (predates this extraction), not introduced by this move.
import { Card } from "@/shared/components";
import { createCurrencyFormatter } from "../costFormatters";

export function TopListCard({
  title,
  rows,
  nameKey,
  valueKey,
  secondaryKey,
  secondaryLabel,
  locale,
  hasCostData,
}: {
  title: string;
  rows: Array<Record<string, any>>;
  nameKey: string;
  valueKey: string;
  secondaryKey?: string;
  secondaryLabel?: string;
  locale: string;
  hasCostData?: boolean;
}) {
  const currencyFormatter = createCurrencyFormatter(locale);

  return (
    <Card className="p-5">
      <h3 className="text-sm font-semibold text-text-muted uppercase tracking-wide mb-4">
        {title}
      </h3>
      <div className="space-y-2">
        {rows.slice(0, 6).map((row) => (
          <div
            key={String(row[nameKey])}
            className="flex items-center justify-between gap-3 rounded-lg border border-border/20 bg-surface/20 px-4 py-3"
          >
            <span className="text-sm text-text-main truncate">{String(row[nameKey])}</span>
            <div className="flex items-center gap-3 shrink-0">
              {secondaryKey ? (
                <span className="text-xs text-text-muted">
                  {new Intl.NumberFormat(locale, { notation: "compact" }).format(
                    Number(row[secondaryKey] || 0)
                  )}{" "}
                  {secondaryLabel}
                </span>
              ) : null}
              <span className="text-sm font-mono text-text-muted">
                {hasCostData || Number(row[valueKey] || 0) > 0 ? (
                  currencyFormatter.format(Number(row[valueKey] || 0))
                ) : (
                  <span className="text-xs italic opacity-70">{t("legacyFreeLabel")}</span>
                )}
              </span>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
