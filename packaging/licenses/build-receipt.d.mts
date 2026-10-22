export function artifactHashes(dist: string): Record<string, string>;
export function writeBuildReceipt(root: string, area: 'runtime' | 'frontend', ids: string[]): void;
export function normalizeBuildInput(root: string, area: string, id: string): string;
export function assertBuildEvidenceSnapshot(receipt: unknown, expected: unknown): void;
export function validateBuildEvidence(root: string, target: string, area: 'runtime' | 'frontend'): {
  kind: 'build-evidence'; target: string; area: 'runtime' | 'frontend'; artifactCount: number; distributionComplete: false;
};
