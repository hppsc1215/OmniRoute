// Extracted from CostOverviewTab.tsx (#7213 file-size ratchet) — no behavior change, verbatim move.
import { Card } from "@/shared/components";

export function ActivityHeatmap({
  title,
  activityMap,
  lessLabel,
  moreLabel,
  locale,
}: {
  title: string;
  activityMap: Record<string, number>;
  lessLabel: string;
  moreLabel: string;
  locale: string;
}) {
  const days: Array<{ date: string; value: number }> = [];
  const today = new Date();
  for (let index = 364; index >= 0; index--) {
    const date = new Date(today);
    date.setDate(date.getDate() - index);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
      date.getDate()
    ).padStart(2, "0")}`;
    days.push({ date: key, value: activityMap[key] || 0 });
  }

  const maxValue = Math.max(...days.map((day) => day.value), 1);
  const getIntensity = (value: number): string => {
    if (value === 0) return "bg-surface/30";
    const ratio = value / maxValue;
    if (ratio < 0.25) return "bg-emerald-900/50";
    if (ratio < 0.5) return "bg-emerald-700/60";
    if (ratio < 0.75) return "bg-emerald-500/70";
    return "bg-emerald-400";
  };

  const weeks: Array<Array<{ date: string; value: number }>> = [];
  for (let index = 0; index < days.length; index += 7) {
    weeks.push(days.slice(index, index + 7));
  }

  return (
    <Card className="p-5">
      <h3 className="text-sm font-semibold text-text-muted uppercase tracking-wide mb-4">
        {title}
      </h3>
      <div className="overflow-x-auto">
        <div className="flex gap-0.75">
          {weeks.map((week) => (
            <div key={week[0]?.date} className="flex flex-col gap-0.75">
              {week.map((day) => (
                <div
                  key={day.date}
                  className={`w-2.75 h-2.75 rounded-xs ${getIntensity(day.value)}`}
                  title={`${day.date}: ${
                    day.value > 0
                      ? `${new Intl.NumberFormat(locale).format(day.value)} tokens`
                      : "No activity"
                  }`}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2 mt-3 text-[10px] text-text-muted">
        <span>{lessLabel}</span>
        <div className="flex gap-0.5">
          <div className="w-2.5 h-2.5 rounded-xs bg-surface/30" />
          <div className="w-2.5 h-2.5 rounded-xs bg-emerald-900/50" />
          <div className="w-2.5 h-2.5 rounded-xs bg-emerald-700/60" />
          <div className="w-2.5 h-2.5 rounded-xs bg-emerald-500/70" />
          <div className="w-2.5 h-2.5 rounded-xs bg-emerald-400" />
        </div>
        <span>{moreLabel}</span>
      </div>
    </Card>
  );
}
