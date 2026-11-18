"use client";

/**
 * 评审凭据表单（A-1 / A-4 共用）。
 *
 * 抽成一个组件的原因很实际：量表审批与文案回写用的是同一套凭据校验，
 * 两处各写一份表单，迟早会出现「一边必填、一边不必填」的裂缝，
 * 而裂缝正好落在「谁签的字」这件事上。
 */

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  EVIDENCE_OPTIONS,
  evidenceNeedsSignedDocument,
  evidenceWarning,
  type EvidenceType,
} from "@/lib/reviewEvidence";

export interface ReviewEvidenceValue {
  reviewer: string;
  reviewerTitle: string;
  evidenceType: EvidenceType | "";
  reviewedAt: string;
  comment: string;
}

export const EMPTY_REVIEW_EVIDENCE: ReviewEvidenceValue = {
  reviewer: "",
  reviewerTitle: "",
  evidenceType: "",
  reviewedAt: "",
  comment: "",
};

/** 与后端 `scale_review.validate_evidence` 同一套要求，先在前端拦一遍。 */
export function validateReviewEvidence(value: ReviewEvidenceValue): string {
  if (!value.evidenceType) return "请选择评审凭据类型。";
  if (!value.reviewer.trim()) return "请填写签字人姓名。";
  if (!value.reviewerTitle.trim()) return "请填写签字人职称或科室。";
  if (!value.reviewedAt.trim()) return "请填写签字日期，例如 2026-11-18。";
  if (value.evidenceType === "verbal_confirmation" && !value.comment.trim()) {
    return "口头／线上确认必须写明依据：何时、由谁、以何方式确认。";
  }
  return "";
}

export function toReviewBody(value: ReviewEvidenceValue) {
  return {
    reviewer: value.reviewer.trim(),
    reviewer_title: value.reviewerTitle.trim(),
    evidence_type: value.evidenceType,
    comment: value.comment.trim(),
    reviewed_at: value.reviewedAt.trim(),
  };
}

export function ReviewEvidenceFields({
  value,
  onChange,
}: {
  value: ReviewEvidenceValue;
  onChange: (patch: Partial<ReviewEvidenceValue>) => void;
}) {
  return (
    <div>
      <div className="mb-3 rounded-clin border border-clin-border bg-clin-muted px-4 py-3 text-clin-xs text-clin-fg-muted">
        签字人是<b>实际评审的那位</b>，不是点按钮的人——外部专家没有系统账号时照实填姓名，
        系统会另记「录入人」。凭据类型决定判读结论是否保留「签字件待补」提示。
      </div>

      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        <div>
          <Label htmlFor="reviewer">签字人姓名</Label>
          <Input
            id="reviewer"
            className="mt-1"
            value={value.reviewer}
            onChange={(event) => onChange({ reviewer: event.target.value })}
            placeholder="如：王建民"
          />
        </div>
        <div>
          <Label htmlFor="reviewer-title">职称／科室</Label>
          <Input
            id="reviewer-title"
            className="mt-1"
            value={value.reviewerTitle}
            onChange={(event) => onChange({ reviewerTitle: event.target.value })}
            placeholder="如：老年医学科 主任医师"
          />
        </div>
        <div>
          <Label htmlFor="reviewed-at">签字日期</Label>
          <Input
            id="reviewed-at"
            type="date"
            className="mt-1"
            value={value.reviewedAt}
            onChange={(event) => onChange({ reviewedAt: event.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="evidence-type">评审凭据</Label>
          <Select
            value={value.evidenceType || undefined}
            onValueChange={(next) => onChange({ evidenceType: next as EvidenceType })}
          >
            <SelectTrigger id="evidence-type" className="mt-1" aria-label="评审凭据类型">
              <SelectValue placeholder="请选择凭据类型" />
            </SelectTrigger>
            <SelectContent>
              {EVIDENCE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="md:col-span-2">
          <Label htmlFor="review-comment">依据说明</Label>
          <Input
            id="review-comment"
            className="mt-1"
            value={value.comment}
            onChange={(event) => onChange({ comment: event.target.value })}
            placeholder={
              evidenceNeedsSignedDocument(value.evidenceType)
                ? "口头确认必填：何时、由谁、以何方式确认"
                : "例如：已按 WS/T 888—2026 附录 B 逐项核对"
            }
          />
        </div>
      </div>

      {value.evidenceType ? (
        <p className="mt-3 text-clin-xs text-clin-fg-muted">
          {EVIDENCE_OPTIONS.find((option) => option.value === value.evidenceType)?.hint}
        </p>
      ) : null}
      {evidenceWarning(value.evidenceType) ? (
        <p className="mt-3 rounded-clin border border-clin-warning px-4 py-3 text-clin-sm text-clin-fg">
          {evidenceWarning(value.evidenceType)}
        </p>
      ) : null}
    </div>
  );
}
