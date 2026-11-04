/** 状态徽标：根据语义给出克制的医疗蓝/中性配色 */

const TONE_CLASS: Record<string, string> = {
  blue: "bg-medical-100 text-medical-800 border-medical-200",
  green: "bg-emerald-100 text-emerald-800 border-emerald-200",
  amber: "bg-amber-100 text-amber-900 border-amber-200",
  red: "bg-red-100 text-red-800 border-red-200",
  gray: "bg-slate-100 text-ink-soft border-slate-200",
};

export type BadgeTone = keyof typeof TONE_CLASS;

export function StatusBadge({
  label,
  tone = "gray",
}: {
  label: string;
  tone?: BadgeTone;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-3 py-1 text-elder font-medium ${TONE_CLASS[tone]}`}
    >
      {label}
    </span>
  );
}
