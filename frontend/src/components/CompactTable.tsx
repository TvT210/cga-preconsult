"use client";

import { useMemo, useState, type ReactNode } from "react";

/** 表格密度：紧凑适合批量核对，标准适合阅读 */
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

const DENSITY_CLASS: Record<TableDensity, { cell: string; head: string; font: string }> = {
  compact: { cell: "px-3 py-1.5", head: "px-3 py-2", font: "text-sm" },
  normal: { cell: "px-5 py-3", head: "px-5 py-3", font: "text-elder" },
};

/**
 * 紧凑数据表：支持列排序、密度切换与多选。
 * 多选由外部持有选中项，组件只负责渲染勾选框与全选。
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
      <div className="px-5 py-8 text-center text-elder text-ink-mute">{emptyMessage}</div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left" style={{ minWidth }}>
        <thead className="border-b border-slate-200 bg-slate-50">
          <tr>
            {selectable ? (
              <th className={`${style.head} w-12`}>
                <input
                  type="checkbox"
                  className="h-5 w-5"
                  checked={allChecked}
                  aria-label="全选"
                  onChange={(event) => onToggleAll?.(event.target.checked)}
                />
              </th>
            ) : null}
            {columns.map((column) => (
              <th
                key={column.key}
                className={`${style.head} text-elder font-semibold text-ink ${
                  column.align === "center"
                    ? "text-center"
                    : column.align === "right"
                      ? "text-right"
                      : ""
                } ${column.className ?? ""}`}
                aria-sort={
                  sortKey === column.key ? (asc ? "ascending" : "descending") : "none"
                }
              >
                {column.sortValue ? (
                  <button
                    type="button"
                    onClick={() => handleSort(column)}
                    className="inline-flex items-center gap-1 rounded px-1 hover:text-medical-700"
                  >
                    {column.header}
                    <span aria-hidden="true" className="text-xs">
                      {sortKey === column.key ? (asc ? "▲" : "▼") : "↕"}
                    </span>
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
                className={`border-b border-slate-100 last:border-0 ${
                  checked ? "bg-medical-50" : ""
                }`}
              >
                {selectable ? (
                  <td className={style.cell}>
                    <input
                      type="checkbox"
                      className="h-5 w-5"
                      checked={checked}
                      aria-label={`选择第 ${key} 行`}
                      onChange={(event) => onToggleRow?.(key, event.target.checked)}
                    />
                  </td>
                ) : null}
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={`${style.cell} ${style.font} ${
                      column.align === "center"
                        ? "text-center"
                        : column.align === "right"
                          ? "text-right"
                          : ""
                    } ${column.className ?? ""}`}
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
