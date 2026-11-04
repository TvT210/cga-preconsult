"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { LoadingState } from "@/components/ErrorState";
import { PatientWorkspace } from "./PatientWorkspace";

/**
 * 患者档案入口页（保持精简）。
 *
 * 实际内容在 PatientWorkspace 中：左侧为可筛选的患者列表，
 * 右侧为选中患者的 tab 详情（预问诊 / 评估 / 报告 / 匹配与提醒 / 时间轴）。
 * 选中状态通过 URL query（`?patient=3&tab=matching`）同步，刷新不丢。
 */
export default function StaffPatientDetailPage() {
  const params = useParams<{ id: string | string[] }>();
  const patientId = Array.isArray(params.id) ? params.id[0] : params.id;

  return (
    <Suspense fallback={<LoadingState label="正在加载患者档案…" />}>
      <PatientWorkspace pathPatientId={patientId} />
    </Suspense>
  );
}
