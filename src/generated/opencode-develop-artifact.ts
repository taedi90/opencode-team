export interface OpenCodeDevelopArtifact {
  issueNumber: number | null
  task: string
  adrDecision: string
  signature: string
}

export const opencodeDevelopArtifact: OpenCodeDevelopArtifact = {
  issueNumber: null,
  task: "local test 1772450351",
  adrDecision: "참조 구현을 최소 이식하고 불필요 기능을 제거한다.",
  signature: "20ec249e3727e58a",
}
