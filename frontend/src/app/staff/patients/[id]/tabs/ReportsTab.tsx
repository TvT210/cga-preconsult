"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, downloadReportFile } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { Paged, ReportDetail, ReportListItem, ReportTemplate } from "@/lib/types";
import { BigButton } from "@/components/BigButton";
import { EmptyState } from "@/components/ErrorState";
import { SectionTitle } from "@/components/PageHeader";
import { ReportSectionsView } from "@/components/ReportSectionsView";

/** 报告 tab：选择模板生成报告、查看详情并导出 Word / PDF */
export function ReportsTab({
  reports,
  activeReport,
  onOpenReport,
  onCreateReport,
  busy,
}: {
  reports: ReportListItem[];
  activeReport: ReportDetail | null;
  onOpenReport: (reportId: string | number) => void;
  onCreateReport: (templateCode?: string) => void;
  busy: boolean;
}) {
  const [templates, setTemplates] = useState<ReportTemplate[]>([]);
  const [templateCode, setTemplateCode] = useState("professional");
  const [exporting, setExporting] = useState("");
  /**
   * 报告列表接口不返回 template_code（只有报告详情有），
   * 这里按需补齐模板编码，保证列表展示与导出文件名都带上模板名。
   */
  const [templateCodes, setTemplateCodes] = useState<Record<string, string>>({});

  /** 载入报告模板 */
  const loadTemplates = useCallback(async () => {
    try {
      const payload = await api.get<ReportTemplate[] | Paged<ReportTemplate>>(
        "/report-templates",
      );
      const items = Array.isArray(payload)
        ? payload
        : (payload?.items ?? []);
      setTemplates(items);
      const active = items.find((item) => item.active) ?? items[0];
      if (active) setTemplateCode(active.code);
    } catch {
      /* 模板不可用时退回默认模板 */
    }
  }, []);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  /** 补齐每份报告的模板编码（列表接口不返回） */
  useEffect(() => {
    const list = reports.slice(0, 20);
    if (list.length === 0) {
      setTemplateCodes({});
      return;
    }
    let cancelled = false;
    void Promise.allSettled(
      list.map((report) => api.get<ReportDetail>(`/reports/${report.id}`)),
    ).then((results) => {
      if (cancelled) return;
      const map: Record<string, string> = {};
      results.forEach((result, index) => {
        if (result.status === "fulfilled" && result.value?.template_code) {
          map[String(list[index].id)] = result.value.template_code;
        }
      });
      setTemplateCodes(map);
    });
    return () => {
      cancelled = true;
    };
  }, [reports]);

  /** 编码 → 模板名，用于导出文件名与界面展示 */
  const templateNameMap = useMemo(() => {
    const map = new Map<string, string>();
    templates.forEach((template) => map.set(template.code, template.name));
    return map;
  }, [templates]);

  const templateNameOf = useCallback(
    (code?: string) => (code ? (templateNameMap.get(code) ?? code) : "默认模板"),
    [templateNameMap],
  );

  /** 导出 Word / PDF，文件名带上模板名 */
  const exportReport = useCallback(
    async (report: ReportListItem, format: "docx" | "pdf") => {
      const key = `${report.id}-${format}`;
      setExporting(key);
      try {
        // 列表接口没有 template_code，缺省时按需取一次报告详情
        let code: string | undefined =
          templateCodes[String(report.id)] ?? report.template_code;
        if (!code) {
          const detail = await api.get<ReportDetail>(`/reports/${report.id}`);
          code = detail?.template_code;
        }
        const fileName = `老年综合评估报告_${report.patient_id}_${templateNameOf(
          code,
        )}_v${report.version ?? 1}.${format}`;
        await downloadReportFile(report.id, format, fileName);
      } catch {
        /* 错误提示已由 api 层统一处理 */
      } finally {
        setExporting("");
      }
    },
    [templateCodes, templateNameOf],
  );

  return (
    <div className="space-y-5">
      <section className="card card-pad">
        <SectionTitle
          title="生成报告"
          extra={
            <BigButton
              disabled={busy}
              onClick={() => onCreateReport(templateCode)}
            >
              按所选模板生成
            </BigButton>
          }
        />
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="field-label" htmlFor="report-template">
              报告模板
            </label>
            <select
              id="report-template"
              className="field-select"
              value={templateCode}
              onChange={(event) => setTemplateCode(event.target.value)}
            >
              {templates.length === 0 ? (
                <option value="professional">专业版（临床医护）</option>
              ) : null}
              {templates.map((template) => (
                <option key={template.code} value={template.code}>
                  {template.name}
                  {template.version ? `（${template.version}）` : ""}
                </option>
              ))}
            </select>
          </div>
          <p className="self-end text-elder text-ink-soft">
            每次生成都会新建一个版本，历史版本保留；导出文件名会带上所选模板名，便于归档区分。
          </p>
        </div>
      </section>

      <section className="card card-pad">
        <SectionTitle title="报告列表" />
        {reports.length === 0 ? (
          <EmptyState message="该患者暂无报告，可在上方选择模板后生成。" />
        ) : (
          <ul className="space-y-3">
            {reports.map((report) => (
              <li
                key={report.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3"
              >
                <div>
                  <p className="text-elder font-semibold text-ink">
                    {report.title || "老年综合评估报告"}
                    {report.version ? `（第 ${report.version} 版）` : ""}
                  </p>
                  <p className="text-elder text-ink-soft">
                    模板：
                    {templateNameOf(
                      templateCodes[String(report.id)] ?? report.template_code,
                    )}{" "}
                    · 生成时间：{formatDateTime(report.created_at)}
                    {report.locked ? " · 已归档锁定" : ""}
                  </p>
                </div>
                <div className="flex flex-wrap gap-3">
                  <BigButton
                    variant="secondary"
                    onClick={() => onOpenReport(report.id)}
                  >
                    查看报告
                  </BigButton>
                  <BigButton
                    variant="ghost"
                    loading={exporting === `${report.id}-docx`}
                    disabled={Boolean(exporting)}
                    onClick={() => void exportReport(report, "docx")}
                  >
                    导出 Word
                  </BigButton>
                  <BigButton
                    variant="ghost"
                    loading={exporting === `${report.id}-pdf`}
                    disabled={Boolean(exporting)}
                    onClick={() => void exportReport(report, "pdf")}
                  >
                    导出 PDF
                  </BigButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {activeReport ? (
        <section className="space-y-3">
          <p className="text-elder text-ink-soft">
            当前查看：{activeReport.title ?? "老年综合评估报告"}
            {activeReport.version ? `（第 ${activeReport.version} 版）` : ""} · 模板：
            {templateNameOf(activeReport.template_code)}
          </p>
          <ReportSectionsView
            sections={activeReport.sections}
            disclaimer={activeReport.disclaimer}
          />
        </section>
      ) : null}
    </div>
  );
}
