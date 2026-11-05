"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

/** 表格密度：紧凑适合批量核对，宽松适合阅读 */
export type TableDensity = "compact" | "normal";

export interface TableColumn<T> {
  /** 列唯一标识 */
  key: string;
  /** 表头文案 */
  header: string;
  /** 单元格渲染 */
  render: (row: T) => ReactNode;
  /** 提供后该列可排序（返回可比较的值） */
  sortValue?: (row: T) => string | number | null | undefined;
  /** 单元格类名（控制列宽） */
  className?: string;
  /** 表头与单元格对齐方式 */
  align?: "left" | "center" | "right";
}

const DENSITY_CLASS: Record<TableDensity, { cell: string; head: string }> = {
  compact: { cell: "px-3 py-1.5", head: "px-3 py-2" },
  normal: { cell: "px-3 py-2.5", head: "px-3 py-2" },
};

/**
 * 紧凑数据表（**医护端**）：13px 字号、细线分隔、hover 变色、列可排序、可多选。
 *
 * 规范 §3：表格 13px，数字 `tabular-nums`；§2：分隔线统一 1px；
 * 表格与图表之间不做卡片包裹。
 */
export function CompactTable<T>({
  columns,
  rows,
  rowKey,
  selectable = false,
  selectedKeys,
  onToggleRow,
  onToggleAll,
  density = "compact",
  emptyMessage = "暂无数据。",
  minWidth = 900,
}: {
  columns: TableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** 是否显示多选列 */
  selectable?: boolean;
  /** 当前选中的行 key 集合 */
  selectedKeys?: Set<string>;
  /** 切换单行选中 */
  onToggleRow?: (key: string, checked: boolean) => void;
  /** 切换全选 */
  onToggleAll?: (checked: boolean) => void;
  density?: TableDensity;
  emptyMessage?: string;
  /** 表格最小宽度（px），保证列宽合理 */
  minWidth?: number;
}) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [asc, setAsc] = useState(true);

  const sorted = useMemo(() => {
    const column = columns.find((item) => item.key === sortKey);
    if (!column?.sortValue) return rows;
    const factor = asc ? 1 : -1;
    return [...rows].sort((left, right) => {
      const a = column.sortValue?.(left);
      const b = column.sortValue?.(right);
      if (a === undefined || a === null) return 1;
      if (b === undefined || b === null) return -1;
      if (typeof a === "number" && typeof b === "number") return (a - b) * factor;
      return String(a).localeCompare(String(b), "zh-CN") * factor;
    });
  }, [asc, columns, rows, sortKey]);

  const style = DENSITY_CLASS[density];
  const allKeys = sorted.map(rowKey);
  const allChecked =
    selectable && allKeys.length > 0 && allKeys.every((key) => selectedKeys?.has(key));

  const handleSort = (column: TableColumn<T>) => {
    if (!column.sortValue) return;
    if (sortKey === column.key) {
      setAsc((prev) => !prev);
      return;
    }
    setSortKey(column.key);
    setAsc(true);
  };

  if (rows.length === 0) {
    return (
      <div className="py-8 text-center text-clin-sm text-clin-fg-subtle">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left" style={{ minWidth }}>
        <thead className="border-b border-clin-border bg-clin-muted">
          <tr>
            {selectable ? (
              <th className={`${style.head} w-10`}>
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-clin-accent"
                  checked={allChecked}
                  aria-label="全选"
                  onChange={(event) => onToggleAll?.(event.target.checked)}
                />
              </th>
            ) : null}
            {columns.map((column) => (
              <th
                key={column.key}
                className={cn(
                  style.head,
                  "text-clin-xs font-medium text-clin-fg-muted",
                  column.align === "center"
                    ? "text-center"
                    : column.align === "right"
                      ? "text-right"
                      : "",
                  column.className ?? "",
                )}
                aria-sort={
                  sortKey === column.key ? (asc ? "ascending" : "descending") : "none"
                }
              >
                {column.sortValue ? (
                  <button
                    type="button"
                    onClick={() => handleSort(column)}
                    className="inline-flex items-center gap-1 rounded-clin-sm px-1 py-0.5 text-left transition-colors duration-150 hover:text-clin-fg"
                  >
                    {column.header}
                    {sortKey === column.key ? (
                      asc ? (
                        <ArrowUp className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <ArrowDown className="h-3 w-3" aria-hidden="true" />
                      )
                    ) : (
                      <ChevronsUpDown
                        className="h-3 w-3 text-clin-fg-subtle"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                ) : (
                  column.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const key = rowKey(row);
            const checked = Boolean(selectedKeys?.has(key));
            return (
              <tr
                key={key}
                className={cn(
                  "border-b border-clin-border transition-colors duration-150 last:border-0 hover:bg-clin-muted",
                  checked && "bg-clin-accent-soft",
                )}
              >
                {selectable ? (
                  <td className={style.cell}>
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-clin-accent"
                      checked={checked}
                      aria-label={`选择第 ${key} 行`}
                      onChange={(event) => onToggleRow?.(key, event.target.checked)}
                    />
                  </td>
                ) : null}
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn(
                      style.cell,
                      "text-clin-sm tabular-nums text-clin-fg",
                      column.align === "center"
                        ? "text-center"
                        : column.align === "right"
                          ? "text-right"
                          : "",
                      column.className ?? "",
                    )}
                  >
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
