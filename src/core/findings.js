import { clamp, truncate } from './utils.js';

export const SEVERITY_WEIGHT = Object.freeze({
  critical: 28,
  high: 16,
  medium: 8,
  low: 3,
  info: 0
});

export const CATEGORY_LABELS = Object.freeze({
  identity: 'Identity',
  location: 'Location',
  collaboration: 'Collaboration',
  external: 'External connections',
  embedded: 'Embedded content',
  active: 'Active content',
  provenance: 'Provenance',
  structure: 'Structure',
  privacy: 'Privacy',
  integrity: 'Integrity',
  compatibility: 'Compatibility'
});

let sequence = 0;

export function finding(input) {
  sequence += 1;
  return {
    id: input.id || `finding-${sequence}`,
    category: input.category || 'privacy',
    severity: input.severity || 'info',
    title: input.title || 'Finding',
    description: input.description || '',
    evidence: input.evidence ? truncate(input.evidence, 360) : null,
    path: input.path || null,
    remediation: input.remediation || null,
    cleanable: Boolean(input.cleanable),
    cleanAction: input.cleanAction || null,
    tags: Array.isArray(input.tags) ? input.tags : []
  };
}

export function dedupeFindings(findings) {
  const seen = new Set();
  return findings.filter((item) => {
    const key = [item.category, item.severity, item.title, item.path, item.evidence].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function summarizeFindings(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const categories = {};
  let score = 0;
  for (const item of findings) {
    counts[item.severity] = (counts[item.severity] || 0) + 1;
    categories[item.category] = (categories[item.category] || 0) + 1;
    score += SEVERITY_WEIGHT[item.severity] ?? 0;
  }
  score = clamp(score, 0, 100);
  let level = 'clear';
  if (score >= 75 || counts.critical) level = 'critical';
  else if (score >= 45 || counts.high >= 2) level = 'high';
  else if (score >= 20 || counts.high) level = 'medium';
  else if (score > 0) level = 'low';

  return {
    score,
    level,
    counts,
    categories,
    total: findings.length,
    actionable: findings.filter((item) => item.severity !== 'info').length,
    cleanable: findings.filter((item) => item.cleanable).length
  };
}
