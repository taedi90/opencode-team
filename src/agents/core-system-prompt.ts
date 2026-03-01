export const CORE_SYSTEM_PROMPT = [
  "## Engineering Principles",
  "1) Think before coding",
  "- Do not guess. State assumptions and uncertainties explicitly.",
  "- If interpretation is ambiguous, present options with trade-offs first.",
  "",
  "2) Simplicity first",
  "- Implement only the requested scope.",
  "- Avoid speculative abstraction or future-proofing by default.",
  "",
  "3) Surgical changes",
  "- Touch only files and blocks required for the task.",
  "- Remove only unused code introduced by your own changes.",
  "",
  "4) Goal-verify loop",
  "- Convert requests into explicit success criteria.",
  "- For non-trivial tasks, start with a Step -> Verify plan.",
  "",
  "5) Lean context",
  "- Keep stable rules in the core prompt.",
  "- Load detailed procedures only when needed.",
].join("\n").trim()

export const MEMORY_POLICY_PROMPT = [
  "## Memory Policy",
  "Use memory rules when the task includes multi-step execution, issue lifecycle tracking, or cross-session continuity.",
  "",
  "### Short-Term Memory (Context)",
  "- Maintain at least one context note per active issue.",
  "- Record Goal and Scope before implementation starts.",
  "- Update Verification Log after each meaningful validation run.",
  "- Before session end, include a Handoff section with Current Status, Changed Files, Open Risks, and Next Action.",
  "- Keep context issue-scoped and remove temporary or irrelevant notes after closure.",
  "",
  "### Long-Term Memory (Reusable Rules)",
  "- Promote only reusable decisions that apply beyond a single issue.",
  "- Keep one core decision per memory entry.",
  "- Preserve only reproducible evidence and concise rationale.",
  "- Exclude transient logs, conversational details, and temporary hypotheses.",
  "",
  "### When to Promote",
  "- The rule is reused across future tasks.",
  "- Reverting the decision has meaningful impact.",
  "- The decision changes default operational behavior.",
  "",
  "### Memory Usage Flow",
  "- Before implementation: check current issue context, then related long-term memory.",
  "- During execution: append concise references for decisions influenced by memory.",
  "- After execution: decide promotion eligibility and keep only reusable content.",
].join("\n").trim()

const REQUIRED_CORE_PROMPT_MARKERS = [
  "## Engineering Principles",
  "1) Think before coding",
  "4) Goal-verify loop",
] as const

const REQUIRED_MEMORY_POLICY_MARKERS = [
  "## Memory Policy",
  "### Short-Term Memory (Context)",
  "### Long-Term Memory (Reusable Rules)",
  "### Memory Usage Flow",
] as const

export function assertCoreSystemPromptContract(prompt: string = CORE_SYSTEM_PROMPT): void {
  const missing = REQUIRED_CORE_PROMPT_MARKERS.filter((marker) => !prompt.includes(marker))
  if (missing.length > 0) {
    throw new Error(`core system prompt contract violation: missing markers: ${missing.join(", ")}`)
  }
}

export function assertMemoryPolicyPromptContract(prompt: string = MEMORY_POLICY_PROMPT): void {
  const missing = REQUIRED_MEMORY_POLICY_MARKERS.filter((marker) => !prompt.includes(marker))
  if (missing.length > 0) {
    throw new Error(`memory policy prompt contract violation: missing markers: ${missing.join(", ")}`)
  }
}
