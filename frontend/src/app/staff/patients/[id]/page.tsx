"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import {
  ageFromBirthDate,
  assessmentStatusLabel,
  formatDateTime,
} from "@/lib/format";
import type {
  AlertItem,
  AssessmentListItem,
  ConsentRecord,
  DialogueSession,
  DialogueTurn,
  MatchRunDetail,
  MatchRunListItem,
  Paged,
  Patient,
  Preconsult,
  ReportDetail,
  ReportListItem,
  TimelineEvent,
} from "@/lib/types";
import { AlertCard } from "@/components/AlertCard";
import { BigButton } from "@/components/BigButton";
import { EmptyState, ErrorState, LoadingState } from "@/components/ErrorState";
import { MatchCandidateCard } from "@/components/MatchCandidateCard";
import { PageHeader, SectionTitle } from "@/components/PageHeader";
import { ReportSectionsView } from "@/components/ReportSectionsView";
import { StatusBadge } from "@/components/StatusBadge";
import { useToast } from "@/components/Toast";

function toItems<T>(payload: T[] | Paged<T> | null | undefined): T[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  return payload.items ?? [];
}

type TabKey = "preconsult" | "assessments" | "reports" | "matching" | "timeline";

const TABS: { key: TabKey; label: string }[] = [
  { key: "preconsult", label: "预问诊" },
  { key: "assessments", label: "评估" },
  { key: "reports", label: "报告" },
  { key: "matching", label: "匹配与提醒" },
  { key: "timeline", label: "时间轴" },
];

/** 以顿号或逗号分隔的文本转数组 */
function splitList(text: string): string[] {
  return text
    .split(/[、,，;；]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 每行一条，用竖线分隔字段 */
function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function linesToText(items?: unknown[]): string {
  if (!Array.isArray(items) || !items.length) return "";
  return items
    .map((item) => {
      if (item && typeof item === "object") {
        return Object.values(item as Record<string, unknown>)
          .map((value) => (value === undefined || value === null ? "" : String(value)))
          .join("|");
      }
      return item === undefined || item === null ? "" : String(item);
    })
    .join("\n");
}

export default function StaffPatientDetailPage() {
  const params = useParams<{ id: string | string[] }>();
  const patientId = Array.isArray(params.id) ? params.id[0] : params.id;
  const toast = useToast();

  const [tab, setTab] = useState<TabKey>("preconsult");
  const [patient, setPatient] = useState<Patient | null>(null);
  const [preconsult, setPreconsult] = useState<Preconsult>({});
  const [assessments, setAssessments] = useState<AssessmentListItem[]>([]);
  const [reports, setReports] = useState<ReportListItem[]>([]);
  const [activeReport, setActiveReport] = useState<ReportDetail | null>(null);
  const [runs, setRuns] = useState<MatchRunListItem[]>([]);
  const [activeRun, setActiveRun] = useState<MatchRunDetail | null>(null);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [consents, setConsents] = useState<ConsentRecord[]>([]);
  const [dialogueTurns, setDialogueTurns] = useState<DialogueTurn[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    setError("");
    try {
      const [
        patientPayload,
        preconsultPayload,
        assessmentPayload,
        reportPayload,
        runPayload,
        alertPayload,
        timelinePayload,
        consentPayload,
      ] = await Promise.all([
        api.get<Patient>(`/patients/${patientId}`),
        api.get<Preconsult>(`/patients/${patientId}/preconsult`),
        api.get<AssessmentListItem[] | Paged<AssessmentListItem>>(
          `/patients/${patientId}/assessments`,
        ),
        api.get<ReportListItem[] | Paged<ReportListItem>>("/reports", {
          patient_id: patientId,
        }),
        api.get<MatchRunListItem[] | Paged<MatchRunListItem>>("/matching/runs", {
          patient_id: patientId,
        }),
        api.get<AlertItem[] | Paged<AlertItem>>("/alerts", {
          patient_id: patientId,
        }),
        api.get<TimelineEvent[] | Paged<TimelineEvent>>(
          `/patients/${patientId}/timeline`,
        ),
        api.get<ConsentRecord[] | Paged<ConsentRecord>>(
          `/patients/${patientId}/consents`,
        ),
      ]);

      setPatient(patientPayload);
      setPreconsult(preconsultPayload ?? {});
      setAssessments(toItems(assessmentPayload));
      setReports(toItems(reportPayload));
      setRuns(toItems(runPayload));
      setAlerts(toItems(alertPayload));
      setTimeline(toItems(timelinePayload));
      setConsents(toItems(consentPayload));
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "暂时无法获取患者档案，请稍后重试。",
      );
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 载入匹配批次详情 */
  const openRun = useCallback(async (runId: string | number) => {
    setBusy(true);
    try {
      const detail = await api.get<MatchRunDetail>(`/matching/runs/${runId}`);
      setActiveRun(detail);
    } catch {
      /* 错误提示已由 api 层统一处理 */
    } finally {
      setBusy(false);
    }
  }, []);

  /** 生成报告 */
  const createReport = useCallback(async () => {
    setBusy(true);
    try {
      const created = await api.post<ReportDetail>("/reports", {
        patient_id: patientId,
      });
      toast("报告已生成。", "success");
      if (created?.id) {
        const detail = await api.get<ReportDetail>(`/reports/${created.id}`);
        setActiveReport(detail);
      }
      await load();
    } catch {
      /* 错误提示已由 api 层统一处理 */
    } finally {
      setBusy(false);
    }
  }, [patientId, load, toast]);

  /** 发起匹配 */
  const runMatching = useCallback(async () => {
    setBusy(true);
    try {
      const run = await api.post<MatchRunDetail>("/matching/run", {
        patient_id: patientId,
      });
      toast("匹配已执行。", "success");
      if (run?.id) {
        const detail = await api.get<MatchRunDetail>(`/matching/runs/${run.id}`);
        setActiveRun(detail);
      }
      await load();
    } catch {
      /* 错误提示已由 api 层统一处理 */
    } finally {
      setBusy(false);
    }
  }, [patientId, load, toast]);

  /** 对话回放 */
  const openDialogue = useCallback(async () => {
    setBusy(true);
    try {
      const session = await api.post<DialogueSession>("/dialogue/sessions", {
        patient_id: patientId,
      });
      const detail = await api.get<DialogueSession>(
        `/dialogue/sessions/${session.id}`,
      );
      setDialogueTurns(detail.turns ?? []);
    } catch {
      toast("暂时无法载入对话记录。", "warning");
    } finally {
      setBusy(false);
    }
  }, [patientId, toast]);

  /** 保存预问诊（增量保存） */
  const savePreconsult = useCallback(async () => {
    setSaving(true);
    try {
      await api.put<Preconsult>(`/patients/${patientId}/preconsult`, preconsult);
      toast("预问诊内容已保存。", "success");
    } catch {
      /* 错误提示已由 api 层统一处理 */
    } finally {
      setSaving(false);
    }
  }, [patientId, preconsult, toast]);

  /** 记录知情同意 */
  const recordConsent = useCallback(async () => {
    setBusy(true);
    try {
      await api.post(`/patients/${patientId}/consent`, {
        agreed: true,
        scope: "老年综合评估与疾病匹配提醒",
      });
      toast("知情同意已记录。", "success");
      const payload = await api.get<ConsentRecord[] | Paged<ConsentRecord>>(
        `/patients/${patientId}/consents`,
      );
      setConsents(toItems(payload));
    } catch {
      /* 错误提示已由 api 层统一处理 */
    } finally {
      setBusy(false);
    }
  }, [patientId, toast]);

  /** 处理就医提醒 */
  const handleAlert = useCallback(
    async (alertId: string | number, action: "ack" | "escalate" | "close", comment: string) => {
      setBusy(true);
      try {
        await api.post(`/alerts/${alertId}/handle`, { action, comment });
        toast("提醒状态已更新。", "success");
        const payload = await api.get<AlertItem[] | Paged<AlertItem>>("/alerts", {
          patient_id: patientId,
        });
        setAlerts(toItems(payload));
      } catch {
        /* 错误提示已由 api 层统一处理 */
      } finally {
        setBusy(false);
      }
    },
    [patientId, toast],
  );

  /** 打开报告详情 */
  const openReport = useCallback(async (reportId: string | number) => {
    setBusy(true);
    try {
      const detail = await api.get<ReportDetail>(`/reports/${reportId}`);
      setActiveReport(detail);
    } catch {
      /* 错误提示已由 api 层统一处理 */
    } finally {
      setBusy(false);
    }
  }, []);

  const basic = preconsult.basic ?? {};
  const chief = preconsult.chief_complaint ?? {};
  const history = preconsult.history ?? {};
  const lifestyle = preconsult.lifestyle ?? {};
  const proxy = preconsult.proxy ?? {};

  const consentCount = consents.length;

  if (loading) {
    return <LoadingState label="正在加载患者档案…" />;
  }

  if (error) {
    return <ErrorState message={error} onRetry={() => void load()} />;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={patient ? `${patient.name} 的档案` : "患者档案"}
        description={
          patient
            ? `编号 ${patient.id} · ${patient.gender} · ${ageFromBirthDate(
                patient.birth_date,
              )} · 联系电话 ${patient.phone || "未填写"}`
            : undefined
        }
        actions={
          <>
            <Link href="/staff/patients">
              <BigButton variant="ghost" size="lg">
                返回患者列表
              </BigButton>
            </Link>
            <BigButton
              variant="secondary"
              size="lg"
              disabled={busy}
              onClick={() => void runMatching()}
            >
              发起疾病匹配
            </BigButton>
            <BigButton size="lg" disabled={busy} onClick={() => void createReport()}>
              生成报告
            </BigButton>
          </>
        }
      />

      <nav className="flex flex-wrap gap-2">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
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

      {/* ------------------------------ 预问诊 ------------------------------ */}
      {tab === "preconsult" ? (
        <div className="space-y-5">
          <section className="card card-pad">
            <SectionTitle
              title="知情同意"
              extra={
                <BigButton variant="secondary" onClick={() => void recordConsent()}>
                  记录同意
                </BigButton>
              }
            />
            {consents.length ? (
              <ul className="space-y-2">
                {consents.map((consent, index) => (
                  <li
                    key={consent.id ?? index}
                    className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-elder text-ink-soft"
                  >
                    {consent.agreed ? "已同意" : "未同意"}
                    {consent.scope ? ` · ${consent.scope}` : ""} ·{" "}
                    {formatDateTime(consent.created_at)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-elder text-ink-mute">暂无同意记录。</p>
            )}
          </section>

          <section className="card card-pad space-y-5">
            <SectionTitle title="基本信息" />
            <div className="grid gap-4 md:grid-cols-3">
              <div>
                <label className="field-label" htmlFor="basic-gender">
                  性别
                </label>
                <input
                  id="basic-gender"
                  className="field-input"
                  value={basic.gender ?? ""}
                  onChange={(event) =>
                    setPreconsult({
                      ...preconsult,
                      basic: { ...basic, gender: event.target.value },
                    })
                  }
                />
              </div>
              <div>
                <label className="field-label" htmlFor="basic-birth">
                  出生日期
                </label>
                <input
                  id="basic-birth"
                  type="date"
                  className="field-input"
                  value={basic.birth_date ?? ""}
                  onChange={(event) =>
                    setPreconsult({
                      ...preconsult,
                      basic: { ...basic, birth_date: event.target.value },
                    })
                  }
                />
              </div>
              <div>
                <label className="field-label" htmlFor="basic-marital">
                  婚姻状况
                </label>
                <input
                  id="basic-marital"
                  className="field-input"
                  value={basic.marital_status ?? ""}
                  onChange={(event) =>
                    setPreconsult({
                      ...preconsult,
                      basic: { ...basic, marital_status: event.target.value },
                    })
                  }
                />
              </div>
              <div>
                <label className="field-label" htmlFor="basic-education">
                  文化程度
                </label>
                <input
                  id="basic-education"
                  className="field-input"
                  value={basic.education ?? ""}
                  onChange={(event) =>
                    setPreconsult({
                      ...preconsult,
                      basic: { ...basic, education: event.target.value },
                    })
                  }
                />
              </div>
              <div>
                <label className="field-label" htmlFor="basic-living">
                  居住状况
                </label>
                <input
                  id="basic-living"
                  className="field-input"
                  value={basic.living_status ?? ""}
                  onChange={(event) =>
                    setPreconsult({
                      ...preconsult,
                      basic: { ...basic, living_status: event.target.value },
                    })
                  }
                />
              </div>
              <div>
                <label className="field-label" htmlFor="basic-insurance">
                  医疗费别
                </label>
                <input
                  id="basic-insurance"
                  className="field-input"
                  value={basic.medical_insurance ?? ""}
                  onChange={(event) =>
                    setPreconsult({
                      ...preconsult,
                      basic: { ...basic, medical_insurance: event.target.value },
                    })
                  }
                />
              </div>
              <div>
                <label className="field-label" htmlFor="basic-contact">
                  联系人
                </label>
                <input
                  id="basic-contact"
                  className="field-input"
                  value={basic.contact_name ?? ""}
                  onChange={(event) =>
                    setPreconsult({
                      ...preconsult,
                      basic: { ...basic, contact_name: event.target.value },
                    })
                  }
                />
              </div>
              <div>
                <label className="field-label" htmlFor="basic-contact-phone">
                  联系人电话
                </label>
                <input
                  id="basic-contact-phone"
                  className="field-input"
                  value={basic.contact_phone ?? ""}
                  onChange={(event) =>
                    setPreconsult({
                      ...preconsult,
                      basic: { ...basic, contact_phone: event.target.value },
                    })
                  }
                />
              </div>
            </div>
          </section>

          <section className="card card-pad space-y-4">
            <SectionTitle title="主诉与现病史" />
            <div className="grid gap-4 md:grid-cols-2">
              <div className="md:col-span-2">
                <label className="field-label" htmlFor="chief-text">
                  主诉
                </label>
                <textarea
                  id="chief-text"
                  className="field-input min-h-[90px]"
                  value={chief.text ?? ""}
                  onChange={(event) =>
                    setPreconsult({
                      ...preconsult,
                      chief_complaint: { ...chief, text: event.target.value },
                    })
                  }
                />
              </div>
              <div>
                <label className="field-label" htmlFor="chief-onset">
                  起病时间
                </label>
                <input
                  id="chief-onset"
                  className="field-input"
                  value={chief.onset ?? ""}
                  onChange={(event) =>
                    setPreconsult({
                      ...preconsult,
                      chief_complaint: { ...chief, onset: event.target.value },
                    })
                  }
                />
              </div>
              <div>
                <label className="field-label" htmlFor="chief-site">
                  部位
                </label>
                <input
                  id="chief-site"
                  className="field-input"
                  value={chief.site ?? ""}
                  onChange={(event) =>
                    setPreconsult({
                      ...preconsult,
                      chief_complaint: { ...chief, site: event.target.value },
                    })
                  }
                />
              </div>
              <div>
                <label className="field-label" htmlFor="chief-nature">
                  性质
                </label>
                <input
                  id="chief-nature"
                  className="field-input"
                  value={chief.nature ?? ""}
                  onChange={(event) =>
                    setPreconsult({
                      ...preconsult,
                      chief_complaint: { ...chief, nature: event.target.value },
                    })
                  }
                />
              </div>
              <div>
                <label className="field-label" htmlFor="chief-severity">
                  严重程度（0~10）
                </label>
                <input
                  id="chief-severity"
                  type="number"
                  min={0}
                  max={10}
                  className="field-input"
                  value={chief.severity ?? ""}
                  onChange={(event) =>
                    setPreconsult({
                      ...preconsult,
                      chief_complaint: {
                        ...chief,
                        severity:
                          event.target.value === "" ? undefined : Number(event.target.value),
                      },
                    })
                  }
                />
              </div>
              <div>
                <label className="field-label" htmlFor="chief-course">
                  病程
                </label>
                <input
                  id="chief-course"
                  className="field-input"
                  value={chief.course ?? ""}
                  onChange={(event) =>
                    setPreconsult({
                      ...preconsult,
                      chief_complaint: { ...chief, course: event.target.value },
                    })
                  }
                />
              </div>
              <div>
                <label className="field-label" htmlFor="chief-associated">
                  伴随症状（顿号分隔）
                </label>
                <input
                  id="chief-associated"
                  className="field-input"
                  value={(chief.associated ?? []).join("、")}
                  onChange={(event) =>
                    setPreconsult({
                      ...preconsult,
                      chief_complaint: {
                        ...chief,
                        associated: splitList(event.target.value),
                      },
                    })
                  }
                />
              </div>
            </div>
          </section>

          <section className="card card-pad space-y-4">
            <SectionTitle title="既往史、用药史与过敏史" />
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="field-label" htmlFor="history-conditions">
                  慢性病清单（顿号分隔）
                </label>
                <input
                  id="history-conditions"
                  className="field-input"
                  value={(history.conditions ?? []).join("、")}
                  onChange={(event) =>
                    setPreconsult({
                      ...preconsult,
                      history: {
                        ...history,
                        conditions: splitList(event.target.value),
                      },
                    })
                  }
                />
              </div>
              <div>
                <label className="field-label" htmlFor="history-medications">
                  长期用药（每行一条：名称|剂量|开始时间）
                </label>
                <textarea
                  id="history-medications"
                  className="field-input min-h-[110px]"
                  value={linesToText(history.medications)}
                  onChange={(event) =>
                    setPreconsult({
                      ...preconsult,
                      history: {
                        ...history,
                        medications: splitLines(event.target.value).map((line) => {
                          const [name, dose, since] = line.split("|");
                          return { name: name ?? "", dose, since };
                        }),
                      },
                    })
                  }
                />
              </div>
              <div className="md:col-span-2">
                <label className="field-label" htmlFor="history-allergies">
                  过敏史（每行一条：药物|反应）
                </label>
                <textarea
                  id="history-allergies"
                  className="field-input min-h-[90px]"
                  value={linesToText(history.allergies)}
                  onChange={(event) =>
                    setPreconsult({
                      ...preconsult,
                      history: {
                        ...history,
                        allergies: splitLines(event.target.value).map((line) => {
                          const [name, reaction] = line.split("|");
                          return { name: name ?? "", reaction };
                        }),
                      },
                    })
                  }
                />
              </div>
            </div>
          </section>

          <section className="card card-pad space-y-4">
            <SectionTitle title="生活方式" />
            <div className="grid gap-4 md:grid-cols-2">
              <label className="flex min-h-btn items-center gap-3 text-elder text-ink">
                <input
                  type="checkbox"
                  className="h-7 w-7"
                  checked={Boolean(lifestyle.smoking)}
                  onChange={(event) =>
                    setPreconsult({
                      ...preconsult,
                      lifestyle: { ...lifestyle, smoking: event.target.checked },
                    })
                  }
                />
                吸烟
              </label>
              <label className="flex min-h-btn items-center gap-3 text-elder text-ink">
                <input
                  type="checkbox"
                  className="h-7 w-7"
                  checked={Boolean(lifestyle.drinking)}
                  onChange={(event) =>
                    setPreconsult({
                      ...preconsult,
                      lifestyle: { ...lifestyle, drinking: event.target.checked },
                    })
                  }
                />
                饮酒
              </label>
              <div>
                <label className="field-label" htmlFor="life-diet">
                  饮食
                </label>
                <input
                  id="life-diet"
                  className="field-input"
                  value={lifestyle.diet ?? ""}
                  onChange={(event) =>
                    setPreconsult({
                      ...preconsult,
                      lifestyle: { ...lifestyle, diet: event.target.value },
                    })
                  }
                />
              </div>
              <div>
                <label className="field-label" htmlFor="life-activity">
                  活动
                </label>
                <input
                  id="life-activity"
                  className="field-input"
                  value={lifestyle.activity ?? ""}
                  onChange={(event) =>
                    setPreconsult({
                      ...preconsult,
                      lifestyle: { ...lifestyle, activity: event.target.value },
                    })
                  }
                />
              </div>
              <div>
                <label className="field-label" htmlFor="life-sleep">
                  睡眠
                </label>
                <input
                  id="life-sleep"
                  className="field-input"
                  value={lifestyle.sleep ?? ""}
                  onChange={(event) =>
                    setPreconsult({
                      ...preconsult,
                      lifestyle: { ...lifestyle, sleep: event.target.value },
                    })
                  }
                />
              </div>
              <div className="md:col-span-2">
                <label className="field-label" htmlFor="life-falls">
                  跌倒史（每行一条：时间|地点|诱因|损伤）
                </label>
                <textarea
                  id="life-falls"
                  className="field-input min-h-[90px]"
                  value={linesToText(lifestyle.falls)}
                  onChange={(event) =>
                    setPreconsult({
                      ...preconsult,
                      lifestyle: {
                        ...lifestyle,
                        falls: splitLines(event.target.value).map((line) => {
                          const [time, place, cause, injury] = line.split("|");
                          return { time, place, cause, injury };
                        }),
                      },
                    })
                  }
                />
              </div>
            </div>
          </section>

          <section className="card card-pad space-y-4">
            <SectionTitle title="代答信息" />
            <div className="grid gap-4 md:grid-cols-3">
              <label className="flex min-h-btn items-center gap-3 text-elder text-ink">
                <input
                  type="checkbox"
                  className="h-7 w-7"
                  checked={Boolean(proxy.is_proxy)}
                  onChange={(event) =>
                    setPreconsult({
                      ...preconsult,
                      proxy: { ...proxy, is_proxy: event.target.checked },
                    })
                  }
                />
                由家属代答
              </label>
              <div>
                <label className="field-label" htmlFor="proxy-name">
                  代答人姓名
                </label>
                <input
                  id="proxy-name"
                  className="field-input"
                  value={proxy.proxy_name ?? ""}
                  onChange={(event) =>
                    setPreconsult({
                      ...preconsult,
                      proxy: { ...proxy, proxy_name: event.target.value },
                    })
                  }
                />
              </div>
              <div>
                <label className="field-label" htmlFor="proxy-relation">
                  与老人关系
                </label>
                <input
                  id="proxy-relation"
                  className="field-input"
                  value={proxy.proxy_relation ?? ""}
                  onChange={(event) =>
                    setPreconsult({
                      ...preconsult,
                      proxy: { ...proxy, proxy_relation: event.target.value },
                    })
                  }
                />
              </div>
            </div>
          </section>

          <div className="flex flex-wrap gap-3">
            <BigButton size="lg" loading={saving} onClick={() => void savePreconsult()}>
              保存预问诊
            </BigButton>
            <BigButton variant="ghost" size="lg" onClick={() => void load()}>
              重新载入
            </BigButton>
          </div>
        </div>
      ) : null}

      {/* ------------------------------ 评估 ------------------------------ */}
      {tab === "assessments" ? (
        <section className="card overflow-hidden">
          {assessments.length === 0 ? (
            <div className="card-pad">
              <EmptyState message="该患者暂无评估记录。" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left">
                <thead className="border-b border-slate-200 bg-slate-50">
                  <tr>
                    <th className="px-5 py-3 text-elder font-semibold text-ink">量表</th>
                    <th className="px-5 py-3 text-elder font-semibold text-ink">状态</th>
                    <th className="px-5 py-3 text-elder font-semibold text-ink">方式</th>
                    <th className="px-5 py-3 text-elder font-semibold text-ink">创建时间</th>
                    <th className="px-5 py-3 text-elder font-semibold text-ink">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {assessments.map((item) => (
                    <tr key={item.id} className="border-b border-slate-100 last:border-0">
                      <td className="px-5 py-3 text-elder text-ink">
                        {item.scale_name || item.scale_code}
                      </td>
                      <td className="px-5 py-3">
                        <StatusBadge
                          label={assessmentStatusLabel(item.status)}
                          tone={item.status === "reviewed" ? "green" : "blue"}
                        />
                      </td>
                      <td className="px-5 py-3 text-elder text-ink-soft">
                        {item.mode === "staff" ? "医护代填" : "老人自填"}
                      </td>
                      <td className="px-5 py-3 text-elder text-ink-soft">
                        {formatDateTime(item.created_at)}
                      </td>
                      <td className="px-5 py-3">
                        <Link href={`/staff/review/${item.id}`}>
                          <BigButton variant="secondary">复核</BigButton>
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {/* ------------------------------ 报告 ------------------------------ */}
      {tab === "reports" ? (
        <div className="space-y-5">
          <section className="card card-pad">
            <SectionTitle title="报告列表" />
            {reports.length === 0 ? (
              <EmptyState message="该患者暂无报告，可点击右上角「生成报告」。" />
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
                        生成时间：{formatDateTime(report.created_at)}
                        {report.locked ? " · 已归档锁定" : ""}
                      </p>
                    </div>
                    <BigButton variant="secondary" onClick={() => void openReport(report.id)}>
                      查看报告
                    </BigButton>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {activeReport ? (
            <ReportSectionsView
              sections={activeReport.sections}
              disclaimer={activeReport.disclaimer}
            />
          ) : null}
        </div>
      ) : null}

      {/* ------------------------------ 匹配与提醒 ------------------------------ */}
      {tab === "matching" ? (
        <div className="space-y-5">
          <section className="card card-pad">
            <SectionTitle
              title="匹配批次"
              extra={
                <BigButton variant="secondary" disabled={busy} onClick={() => void runMatching()}>
                  重新匹配
                </BigButton>
              }
            />
            {runs.length === 0 ? (
              <EmptyState message="暂无匹配记录，可点击「发起疾病匹配」。" />
            ) : (
              <ul className="space-y-3">
                {runs.map((run) => (
                  <li
                    key={run.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3"
                  >
                    <div>
                      <p className="text-elder font-semibold text-ink">
                        批次 {run.id}
                      </p>
                      <p className="text-elder text-ink-soft">
                        运行时间：{formatDateTime(run.created_at)}
                      </p>
                    </div>
                    <BigButton variant="secondary" onClick={() => void openRun(run.id)}>
                      查看候选
                    </BigButton>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {activeRun ? (
            <section className="space-y-4">
              <h2 className="text-elder-lg font-semibold text-ink">候选疾病与依据</h2>
              {activeRun.alert ? (
                <div className="rounded-xl2 border-2 border-red-300 bg-red-50 p-4">
                  <p className="text-elder font-semibold text-red-800">
                    就医提醒：{activeRun.alert.message}
                  </p>
                  {activeRun.alert.department ? (
                    <p className="mt-1 text-elder text-red-800">
                      建议就诊科室：{activeRun.alert.department}
                    </p>
                  ) : null}
                </div>
              ) : null}
              <div className="space-y-4">
                {(activeRun.candidates ?? []).map((candidate, index) => (
                  <MatchCandidateCard
                    key={candidate.disease_code || index}
                    candidate={candidate}
                    rank={index + 1}
                    disclaimer={activeRun.disclaimer}
                  />
                ))}
              </div>
              {activeRun.candidates?.length ? null : (
                <p className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-elder text-amber-900">
                  {activeRun.disclaimer || "结果仅供参考，不构成诊断，请及时咨询医生。"}
                </p>
              )}
            </section>
          ) : null}

          <section className="card card-pad">
            <SectionTitle title="就医提醒" />
            {alerts.length === 0 ? (
              <EmptyState message="该患者暂无就医提醒。" />
            ) : (
              <ul className="space-y-4">
                {alerts.map((alert) => (
                  <li key={alert.id}>
                    <AlertCard
                      alert={alert}
                      handling={busy}
                      onHandle={(action, comment) =>
                        void handleAlert(alert.id, action, comment)
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card card-pad" id="dialogue">
            <SectionTitle
              title="AI 对话回放"
              extra={
                <BigButton variant="secondary" disabled={busy} onClick={() => void openDialogue()}>
                  载入对话
                </BigButton>
              }
            />
            {dialogueTurns.length === 0 ? (
              <EmptyState message="点击「载入对话」查看该患者的对话记录。" />
            ) : (
              <ol className="space-y-3">
                {dialogueTurns.map((turn, index) => (
                  <li
                    key={`${turn.created_at ?? "t"}-${index}`}
                    className={[
                      "rounded-xl px-4 py-3 text-elder whitespace-pre-wrap",
                      turn.role === "user"
                        ? "ml-6 bg-medical-700 text-white"
                        : "mr-6 border border-slate-200 bg-slate-50 text-ink",
                    ].join(" ")}
                  >
                    {turn.content}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      ) : null}

      {/* ------------------------------ 时间轴 ------------------------------ */}
      {tab === "timeline" ? (
        <section className="card card-pad">
          <SectionTitle title="患者时间轴" />
          {timeline.length === 0 ? (
            <EmptyState message="暂无时间轴记录。" />
          ) : (
            <ol className="space-y-4 border-l-2 border-slate-200 pl-6">
              {timeline.map((event, index) => (
                <li key={event.id ?? index} className="relative">
                  <span
                    aria-hidden="true"
                    className="absolute -left-[31px] top-2 h-3 w-3 rounded-full bg-medical-700"
                  />
                  <p className="text-elder font-semibold text-ink">
                    {event.title ?? event.category ?? event.type ?? "记录"}
                  </p>
                  <p className="mt-1 text-elder text-ink-soft">
                    {event.description ?? "—"}
                  </p>
                  <p className="mt-1 text-elder text-ink-mute">
                    {formatDateTime(event.created_at)}
                    {event.operator ? ` · ${event.operator}` : ""}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : null}

      <p className="text-elder text-ink-mute">
        知情同意记录条数：{consentCount}。全部数据修改均由后端写入审计日志。
      </p>
    </div>
  );
}
