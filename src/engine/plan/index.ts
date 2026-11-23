export * from './types'
export {
  buildScenario,
  planBalancesFromPortfolio,
  validatePlanIntake,
  withSnapshotBalances,
  PLAN_AS_OF_DATE,
} from './intake'
export type { PlanIntakeBalances, PlanIntakeValues } from './intake'
export { analyzePlan, stressFinalBalances } from './analyze'
export type {
  PlanAnalysis,
  PlanAnalysisOptions,
  PlanStressResult,
} from './analyze'
export { comparePlanAnalyses } from './analysis-delta'
export type {
  PlanAnalysisChange,
  PlanAnalysisChangeDirection,
  PlanAnalysisComparison,
} from './analysis-delta'
export {
  ACA_FPL_SOURCE_2025,
  ACA_PTC_SOURCE_2026,
  ACA_CONTRIBUTION_SOURCE_2026,
  ACA_PLANNING_FPL_GROWTH_RATE,
  ACA_DEFAULT_CONTRIBUTION_RATE,
  ACA_RULE_2026,
  ACA_RULE_2027,
  annualAcaFpl,
  buildAcaRules,
  projectHealthcareYear,
  validateHealthcarePlan,
} from './healthcare'
export {
  committedLifeEvents,
  projectScenario,
  projectScenarioBothModes,
} from './projection'
export {
  annualSocialSecurityBenefitAtAge,
  calculateSocialSecurityBenefit,
  materializeSocialSecurityIncomeStreams,
  SOCIAL_SECURITY_MAX_TAXABLE_FRACTION,
  SOCIAL_SECURITY_RULES_AS_OF,
  SOCIAL_SECURITY_RULES_SOURCE,
  validateSocialSecurityBenefit,
} from './social-security'
export type { SocialSecurityBenefitResult } from './social-security'
export { evaluatePlanVerdict } from './verdict'
export type {
  PlanVerdict,
  PlanVerdictResult,
  VerdictMetric,
  VerdictOptions,
} from './verdict'
export { solveMinimumOutsideIncome } from './income-solver'
export type {
  IncomeSolverEvaluation,
  IncomeSolverOptions,
  IncomeSolverResult,
} from './income-solver'
export {
  STRESS_SCENARIO_IDS,
  buildStressScenarioSuite,
  materializeStressScenarios,
  projectStressScenarioSuite,
} from './stress-scenarios'
export type {
  DownsizeStressScenarioCase,
  ProjectedStressScenario,
  StressScenarioBuildOptions,
  StressScenarioCase,
  StressScenarioCaseId,
  StressScenarioDefinition,
  StressScenarioId,
  StressScenarioSuite,
} from './stress-scenarios'
export {
  MEDICARE_ELIGIBILITY_AGE,
  PENALTY_FREE_ACCESS_AGE,
  buildBridgeSummary,
  buildLifetimeSeries,
  buildMilestones,
  planToJson,
  planToMarkdown,
} from './summary'
export type {
  BridgeSummary,
  LifetimeChartPoint,
  PlanMilestone,
} from './summary'
