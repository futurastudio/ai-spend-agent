import type { AttributionCandidate, AttributionMapping, UsageRecord } from "./schema.js";

export function classifyAttributionConfidence(confidence: number): AttributionMapping["status"] {
  if (confidence >= 0.95) {
    return "auto_mapped";
  }
  if (confidence >= 0.75) {
    return "needs_confirmation";
  }
  if (confidence >= 0.5) {
    return "needs_question";
  }
  return "unmapped";
}

export function attributeUsageRecords(records: UsageRecord[]): AttributionMapping[] {
  return records.map((record) => {
    const candidates = buildCandidates(record).sort((left, right) => right.confidence - left.confidence);
    const selected = candidates[0];
    const status = selected ? classifyAttributionConfidence(selected.confidence) : "unmapped";
    return {
      usageRecordId: record.id,
      candidates,
      selected: status === "unmapped" ? undefined : selected,
      status,
      evidence: candidates.flatMap((candidate) => candidate.evidence)
    };
  });
}

function buildCandidates(record: UsageRecord): AttributionCandidate[] {
  const candidates: AttributionCandidate[] = [];

  if (record.projectId) {
    candidates.push({
      entityType: "project",
      entityId: record.projectId,
      confidence: 0.98,
      evidence: [`usage record includes projectId ${record.projectId}`]
    });
  }
  if (record.clientId) {
    candidates.push({
      entityType: "client",
      entityId: record.clientId,
      confidence: 0.97,
      evidence: [`usage record includes clientId ${record.clientId}`]
    });
  }
  if (record.agentId) {
    candidates.push({
      entityType: "agent",
      entityId: record.agentId,
      confidence: 0.96,
      evidence: [`usage record includes agentId ${record.agentId}`]
    });
  }
  if (record.userId) {
    candidates.push({
      entityType: "user",
      entityId: record.userId,
      confidence: 0.94,
      evidence: [`usage record includes userId ${record.userId}`]
    });
  }
  if (record.workspaceId) {
    candidates.push({
      entityType: "workspace",
      entityId: record.workspaceId,
      confidence: 0.93,
      evidence: [`usage record includes workspaceId ${record.workspaceId}`]
    });
  }
  if (record.apiKeyId) {
    candidates.push({
      entityType: "api_key",
      entityId: record.apiKeyId,
      confidence: 0.9,
      evidence: [`usage record includes apiKeyId ${record.apiKeyId}`]
    });
  }

  const operation = record.operation?.toLowerCase() ?? "";
  const clientMatch = operation.match(/client[_-]([a-z0-9-]+)/);
  if (clientMatch?.[1]) {
    candidates.push({
      entityType: "client",
      entityId: `client-${clientMatch[1]}`,
      confidence: 0.82,
      evidence: [`operation label references client_${clientMatch[1]}`]
    });
  }

  const agentMatch = operation.match(/agent[_-]([a-z0-9-]+)/);
  if (agentMatch?.[1]) {
    candidates.push({
      entityType: "agent",
      entityId: `agent-${agentMatch[1]}`,
      confidence: 0.8,
      evidence: [`operation label references agent_${agentMatch[1]}`]
    });
  }

  if (candidates.length === 0 && /claude|anthropic/i.test(`${record.source.provider} ${record.model}`)) {
    candidates.push({
      entityType: "agent",
      entityId: "agent-claude-workflows",
      confidence: 0.58,
      evidence: [`model/source suggests Claude or Anthropic workflow: ${record.model}`]
    });
  }

  return dedupeCandidates(candidates);
}

function dedupeCandidates(candidates: AttributionCandidate[]): AttributionCandidate[] {
  const byKey = new Map<string, AttributionCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.entityType}:${candidate.entityId}`;
    const existing = byKey.get(key);
    if (!existing || candidate.confidence > existing.confidence) {
      byKey.set(key, candidate);
    }
  }
  return Array.from(byKey.values());
}
