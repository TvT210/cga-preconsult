"use client";

import { useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ageFromBirthDate } from "@/lib/format";
import { BigButton } from "@/components/BigButton";
import { EmptyState, ErrorState, LoadingState } from "@/components/ErrorState";
import { PageHeader } from "@/components/PageHeader";
import { PatientListPanel } from "./PatientListPanel";
import { usePatientWorkspace } from "./usePatientWorkspace";
import { AssessmentsTab } from "./tabs/AssessmentsTab";
import { MatchingTab } from "./tabs/MatchingTab";
import { PreconsultTab } from "./tabs/PreconsultTab";
import { ReportsTab } from "./tabs/ReportsTab";
import { TimelineTab } from "./tabs/TimelineTab";

type TabKey = "preconsult" | "assessments" | "reports" | "matching" | "timeline";

const TABS: { key: TabKey; label: string }[] = [
  { key: "preconsult", label: "预问诊" },
  { key: "assessments", label: "评估" },
  { key: "reports", label: "报告" },
  { key: "matching", label: "匹配与提醒" },
  { key: "timeline", label: "时间轴" },
];

/**
 * 患者档案工作区：左侧患者列表 + 右侧详情（tab 化）。
 *
 * 选中患者与当前 tab 都写回 URL query（`?patient=3&tab=matching`），
 * 因此刷新页面不会丢失选中状态，链接也可直接分享。
 */
export function PatientWorkspace({ pathPatientId }: { pathPatientId?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const queryPatientId = searchParams.get("patient") ?? "";
  const selectedId = queryPatientId || pathPatientId || "";

  const tabParam = searchParams.get("tab") ?? "";
  const tab: TabKey = TABS.some((item) => item.key === tabParam)
    ? (tabParam as TabKey)
    : "preconsult";

  const workspace = usePatientWorkspace(selectedId);

  /** 切换患者：同时同步路径与 query，保持链接可分享 */
  const handleSelect = useCallback(
    (patientId: string) => {
      router.replace(`/staff/patients/${patientId}?patient=${patientId}&tab=${tab}`, {
        scroll: false,
      });
    },
    [router, tab],
  );

  /** 切换 tab：写回 query，刷新后仍停留在同一个 tab */
  const handleTabChange = useCallback(
    (next: TabKey) => {
      const target = selectedId || pathPatientId || "";
      router.replace(
        target
          ? `/staff/patients/${target}?patient=${target}&tab=${next}`
          : `?tab=${next}`,
        { scroll: false },
      );
    },
    [pathPatientId, router, selectedId],
  );

  const patient = workspace.patient;

  const description = useMemo(() => {
    if (!patient) return undefined;
    return `编号 ${patient.code ?? patient.id} · ${patient.gender} · ${ageFromBirthDate(
      patient.birth_date,
    )} · 联系电话 ${patient.phone || "未填写"}`;
  }, [patient]);

  return (
    <div className="space-y-5">
      <PageHeader
        title={patient ? `${patient.name} 的档案` : "患者档案"}
        description={description}
        actions={
          <>
            <BigButton
              variant="secondary"
              size="lg"
              disabled={workspace.busy || !selectedId}
              onClick={() => void workspace.runMatching()}
            >
              发起疾病匹配
            </BigButton>
            <BigButton
              size="lg"
              disabled={workspace.busy || !selectedId}
              onClick={() => {
                handleTabChange("reports");
              }}
            >
              生成报告
            </BigButton>
          </>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[300px_1fr]">
        {/* 左：可筛选的患者列表 */}
        <PatientListPanel selectedId={selectedId} onSelect={handleSelect} />

        {/* 右：选中患者的详情 */}
        <div className="min-w-0">
          {!selectedId ? (
            <EmptyState message="请在左侧选择一位患者查看档案。" />
          ) : workspace.loading && !patient ? (
            <LoadingState label="正在加载患者档案…" />
          ) : workspace.error ? (
            <ErrorState
              message={workspace.error}
              onRetry={() => void workspace.load()}
            />
          ) : (
            <>
              <nav className="mb-4 flex flex-wrap gap-2">
                {TABS.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => handleTabChange(item.key)}
                    aria-pressed={tab === item.key}
                    className={[
                      "min-h-btn rounded-xl border-2 px-4 py-2 text-elder font-semibold transition-colors",
                      tab === item.key
                        ? "border-medical-700 bg-medical-700 text-white"
                        : "border-slate-300 bg-white text-ink hover:border-medical-400",
                    ].join(" ")}
                  >
                    {item.label}
                  </button>
                ))}
              </nav>

              {tab === "preconsult" ? (
                <PreconsultTab
                  preconsult={workspace.preconsult}
                  consents={workspace.consents}
                  onRecordConsent={() => void workspace.recordConsent()}
                />
              ) : null}

              {tab === "assessments" ? (
                <AssessmentsTab assessments={workspace.assessments} />
              ) : null}

              {tab === "reports" ? (
                <ReportsTab
                  reports={workspace.reports}
                  activeReport={workspace.activeReport}
                  onOpenReport={(id) => void workspace.openReport(id)}
                  onCreateReport={(code) => void workspace.createReport(code)}
                  busy={workspace.busy}
                />
              ) : null}

              {tab === "matching" ? (
                <MatchingTab
                  runs={workspace.runs}
                  activeRun={workspace.activeRun}
                  aiReview={workspace.aiReview}
                  alerts={workspace.alerts}
                  dialogueTurns={workspace.dialogueTurns}
                  busy={workspace.busy}
                  onRunMatching={() => void workspace.runMatching()}
                  onOpenRun={(id) => void workspace.openRun(id)}
                  onAiReview={(id) => void workspace.requestAiReview(id)}
                  onHandleAlert={(id, action, comment) =>
                    void workspace.handleAlert(id, action, comment)
                  }
                  onOpenDialogue={() => void workspace.openDialogue()}
                />
              ) : null}

              {tab === "timeline" ? (
                <TimelineTab timeline={workspace.timeline} />
              ) : null}

              <p className="mt-4 text-elder text-ink-mute">
                知情同意记录条数：{workspace.consents.length}。全部数据修改均由后端写入审计日志。
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
