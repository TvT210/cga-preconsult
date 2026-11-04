"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import type {
  AiReview,
  AlertItem,
  AssessmentListItem,
  ConsentRecord,
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

/** 列表接口的两种返回形态统一取数组 */
export function toItems<T>(payload: T[] | Paged<T> | null | undefined): T[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  return payload.items ?? [];
}

/**
 * 患者档案工作区的数据装载与操作。
 * 把详情页的数据逻辑从视图层抽出来，便于各 tab 组件复用。
 */
export function usePatientWorkspace(patientId?: string) {
  const [patient, setPatient] = useState<Patient | null>(null);
  const [preconsult, setPreconsult] = useState<Preconsult>({});
  const [assessments, setAssessments] = useState<AssessmentListItem[]>([]);
  const [reports, setReports] = useState<ReportListItem[]>([]);
  const [activeReport, setActiveReport] = useState<ReportDetail | null>(null);
  const [runs, setRuns] = useState<MatchRunListItem[]>([]);
  const [activeRun, setActiveRun] = useState<MatchRunDetail | null>(null);
  const [aiReview, setAiReview] = useState<AiReview | null>(null);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [consents, setConsents] = useState<ConsentRecord[]>([]);
  const [dialogueTurns, setDialogueTurns] = useState<DialogueTurn[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  /** 载入该患者的全部档案数据 */
  const load = useCallback(async () => {
    if (!patientId) {
      setLoading(false);
      return;
    }
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

  /** 切换患者时清空上一位患者的临时状态 */
  useEffect(() => {
    setActiveRun(null);
    setAiReview(null);
    setActiveReport(null);
    setDialogueTurns([]);
  }, [patientId]);

  /** 载入匹配批次详情 */
  const openRun = useCallback(async (runId: string | number) => {
    setBusy(true);
    try {
      const detail = await api.get<MatchRunDetail>(`/matching/runs/${runId}`);
      setActiveRun(detail);
      setAiReview(detail.ai_review ?? null);
    } catch {
      /* 错误提示已由 api 层统一处理 */
    } finally {
      setBusy(false);
    }
  }, []);

  /** 对当前批次执行 AI 语义复核（只给建议，不改结论） */
  const requestAiReview = useCallback(async (runId: string | number) => {
    setBusy(true);
    try {
      const review = await api.post<AiReview>(`/matching/runs/${runId}/ai-review`);
      setAiReview(review);
      // 同时载入该批次的规则结果，供「规则排序 vs AI 建议排序」并列展示
      const detail = await api.get<MatchRunDetail>(`/matching/runs/${runId}`);
      setActiveRun(detail);
      toast("AI 复核完成，请结合规则排序由医师裁决。", "success");
    } catch {
      /* 错误提示已由 api 层统一处理 */
    } finally {
      setBusy(false);
    }
  }, []);

  /** 生成报告（可选模板） */
  const createReport = useCallback(
    async (templateCode?: string) => {
      setBusy(true);
      try {
        const created = await api.post<ReportDetail>("/reports", {
          patient_id: patientId,
          template_code: templateCode,
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
    },
    [patientId, load],
  );

  /** 发起疾病匹配 */
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
        setAiReview(detail.ai_review ?? null);
      }
      await load();
    } catch {
      /* 错误提示已由 api 层统一处理 */
    } finally {
      setBusy(false);
    }
  }, [patientId, load]);

  /** 对话回放 */
  const openDialogue = useCallback(async () => {
    setBusy(true);
    try {
      const session = await api.post<{ id: string }>("/dialogue/sessions", {
        patient_id: patientId,
      });
      const detail = await api.get<{ turns?: DialogueTurn[] }>(
        `/dialogue/sessions/${session.id}`,
      );
      setDialogueTurns(detail.turns ?? []);
    } catch {
      toast("暂时无法载入对话记录。", "warning");
    } finally {
      setBusy(false);
    }
  }, [patientId]);

  /**
   * 记录知情同意
   *
   * 注：预问诊内容的**采集与编辑**属线 A（患者端），医护端只读，
   * 因此这里不再提供 savePreconsult。
   */
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
  }, [patientId]);

  /** 处理就医提醒（含标记误报） */
  const handleAlert = useCallback(
    async (
      alertId: string | number,
      action: "ack" | "escalate" | "close" | "mark_false" | "revoke_false",
      comment: string,
    ) => {
      setBusy(true);
      try {
        await api.post(`/alerts/${alertId}/handle`, { action, comment });
        toast(
          action === "mark_false"
            ? "已标记为误报，将计入质控看板的误报率。"
            : "提醒状态已更新。",
          "success",
        );
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
    [patientId],
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

  return {
    patient,
    preconsult,
    assessments,
    reports,
    activeReport,
    runs,
    activeRun,
    aiReview,
    alerts,
    timeline,
    consents,
    dialogueTurns,
    loading,
    error,
    busy,
    load,
    setActiveReport,
    openRun,
    requestAiReview,
    createReport,
    runMatching,
    openDialogue,
    recordConsent,
    handleAlert,
    openReport,
  };
}

/** 工作区数据类型（供各 tab 组件引用） */
export type PatientWorkspaceApi = ReturnType<typeof usePatientWorkspace>;
