export interface OpenCodeDevelopArtifact {
  issueNumber: number | null
  task: string
  adrDecision: string
  signature: string
}

export const opencodeDevelopArtifact: OpenCodeDevelopArtifact = {
  issueNumber: null,
  task: "현재 코드에서 문제점을 찾아서 리포트해줘",
  adrDecision: "참조 구현을 최소 이식하고 불필요 기능을 제거한다.",
  signature: "5d0be50db932face",
}
