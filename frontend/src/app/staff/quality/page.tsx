"use client";

import { QualityDashboard } from "@/components/QualityDashboard";
import { PageHeader } from "@/components/PageHeader";

/**
 * 质控看板（放在医护端，staff / doctor / admin 均可访问）。
 * 管理员接口 403 时自动降级为公开接口聚合，页面会标注「部分指标需管理员权限」。
 */
export default function StaffQualityPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="质控看板"
        description="汇总评估完成、复核、提醒闭环与匹配效果等指标，帮助医护把握当前服务质量与难例分布。"
      />
      <QualityDashboard />
    </div>
  );
}
