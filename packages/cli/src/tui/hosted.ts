import type { Verdict } from "../../../core/src/types";

export interface HostedStage {
  stage?: string;
  status?: string;
  summary?: string;
}

export interface HostedWorkView {
  workOrder?: {
    workOrderId?: string;
    status?: string;
    currentStage?: string;
    verificationVerdict?: string;
    verificationIngested?: boolean;
  };
  run?: { run_id?: string; status?: string };
  stages?: HostedStage[];
}

const VERDICTS = new Set(["PASS", "FAIL", "UNKNOWN"]);

function agentClaimedPass(stages: HostedStage[]): boolean {
  return stages.some((stage) => /tests?\s+passed|\bPASS\b/i.test(stage.summary ?? ""));
}

export function hostedVerificationFromView(view: HostedWorkView): { ingested: boolean; verdict: Verdict; detail: string } {
  const order = view.workOrder ?? {};
  const stages = view.stages ?? [];
  const claimed = agentClaimedPass(stages);
  if (!order.verificationIngested) {
    return {
      ingested: false,
      verdict: "UNKNOWN",
      detail: claimed
        ? "Agent stage text is not a verdict. Missing Action OIDC ingest is UNKNOWN."
        : "Waiting for Action OIDC ingest of tb check. Missing ingest is UNKNOWN.",
    };
  }
  const raw = order.verificationVerdict === "NEEDS_REVIEW" ? "UNKNOWN" : order.verificationVerdict;
  const verdict: Verdict = raw && VERDICTS.has(raw) ? raw as Verdict : "UNKNOWN";
  return { ingested: true, verdict, detail: `Ingested tb check verdict ${verdict}.` };
}

export function hostedStageTools(view: HostedWorkView): Array<{ id: string; name: string; status: "done" | "running" | "locked"; result: string }> {
  return (view.stages ?? []).map((stage, index) => ({
    id: `hosted-${index}-${stage.stage ?? "stage"}`,
    name: stage.stage ?? "stage",
    status: stage.status === "running" ? "running" : "done",
    result: stage.summary ?? stage.status ?? "",
  }));
}
