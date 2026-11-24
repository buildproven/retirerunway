// MCP server over the deterministic plan engine (REQ-MCP-1..4), the
// portfolio engine (REQ-MCP-5..8, src/mcp/portfolio-tools.ts) and the local
// user data store (REQ-MCP-10..15, src/mcp/user-data-tools.ts).
// The engine computes every number; this layer only validates input shape,
// calls the engine, and stamps each result with provenance. It is
// transport-free: the stdio entry (src/mcp/main.ts) and the hosted HTTP entry
// (src/app/api/mcp/route.ts, REQ-MCP-24) serve the same factory.
import { McpServer } from '@modelcontextprotocol/server'
import packageJson from '../../package.json'
import {
  SOCIAL_SECURITY_RULES_AS_OF,
  SOCIAL_SECURITY_RULES_SOURCE,
  analyzePlan,
  buildScenario,
  comparePlanAnalyses,
  planToJson,
  validatePlanIntake,
} from '../engine/plan'
import type { PlanAnalysisOptions, Scenario } from '../engine/plan'
import { runPlanMonteCarlo } from '../engine/plan/monte-carlo'
import { stamp } from '../../skills/retire-runway/scripts/provenance'
import {
  analyzePlanInput,
  buildPlanInput,
  comparePlansInput,
  planIntakeSchema,
  planJsonObject,
  planMonteCarloInput,
} from './schemas'
import { registerPortfolioTools } from './portfolio-tools'
import { SERVER_INSTRUCTIONS } from './instructions'
import { registerUserDataTools } from './user-data-tools'
import { recordTools, registerToolDoor } from './tool-door'
import { jsonResult } from './result'

interface IntakeFieldError {
  /** Intake field the engine rejected, or `intake` when no field is named. */
  readonly field: string
  readonly message: string
}

const INTAKE_FIELDS: ReadonlySet<string> = new Set(
  Object.keys(planIntakeSchema.shape)
)

// Engine messages that describe a field without using its key.
const MESSAGE_FIELD_ALIASES: readonly (readonly [RegExp, string])[] = [
  [/ACA residence region/, 'acaResidenceRegion'],
  [/Social Security benefit type/, 'socialSecurityBenefitType'],
  [
    /eligibility must be explicitly confirmed/,
    'divorcedSpouseEligibilityConfirmed',
  ],
  [/claimant full retirement age/, 'socialSecurityClaimantFullRetirementAge'],
  [/\bfullRetirementAge\b/, 'socialSecurityFullRetirementAge'],
]

/** Maps an engine validation message to the intake field it rejects. */
export function intakeErrorField(message: string): string {
  const named = message
    .match(/[A-Za-z0-9]+/g)
    ?.find(word => INTAKE_FIELDS.has(word))
  if (named) return named
  const alias = MESSAGE_FIELD_ALIASES.find(([pattern]) => pattern.test(message))
  return alias ? alias[1] : 'intake'
}

function scenarioAssumptions(scenario: Scenario): Record<string, unknown> {
  return {
    ...scenario.assumptions,
    socialSecurityRulesAsOf: SOCIAL_SECURITY_RULES_AS_OF,
    socialSecurityRulesSource: SOCIAL_SECURITY_RULES_SOURCE,
  }
}

export function createPlanServer(): McpServer {
  const server = new McpServer(
    {
      name: 'retire-runway',
      version: packageJson.version,
    },
    { instructions: SERVER_INSTRUCTIONS }
  )
  // REQ-MCP-73: record every tool so run_tool and the briefing can reach it.
  const registry = recordTools(server)

  server.registerTool(
    'build_plan',
    {
      title: 'Build retirement plan',
      description:
        'Validate plan intake values and build the engine scenario. Returns the scenario and the analysis options to pass to analyze_plan, or field-level errors.',
      inputSchema: buildPlanInput,
    },
    async ({ intake }) => {
      try {
        validatePlanIntake(intake)
      } catch (error) {
        if (!(error instanceof Error)) throw error
        const errors: IntakeFieldError[] = [
          { field: intakeErrorField(error.message), message: error.message },
        ]
        return { ...jsonResult({ ok: false, errors }), isError: true }
      }
      const scenario = buildScenario(intake)
      const analysisOptions: PlanAnalysisOptions = {
        reserveFloor: intake.reserveFloor,
        socialSecurityAge: intake.socialSecurityStartAge,
      }
      return jsonResult({
        ok: true,
        scenario,
        analysisOptions,
        provenance: stamp(
          'build_plan',
          { intake },
          { scenario, analysisOptions },
          { assumptions: scenarioAssumptions(scenario) }
        ),
      })
    }
  )

  server.registerTool(
    'analyze_plan',
    {
      title: 'Analyze retirement plan',
      description:
        'Run the deterministic plan engine on a scenario. Returns the GO, CAUTION or DELAY verdict with reasons, stress-test results, minimum outside income, and a provenance stamp.',
      inputSchema: analyzePlanInput,
    },
    async args => {
      // The JSON form is what the client receives (undefined fields dropped); validate it as an object.
      const text = planToJson(analyzePlan(args.scenario, args.options))
      const parsed = planJsonObject.safeParse(JSON.parse(text))
      if (!parsed.success) {
        throw new Error(
          `analyze_plan: planToJson did not give a JSON object: ${parsed.error.message}`
        )
      }
      const plan = parsed.data
      return jsonResult({
        plan,
        provenance: stamp('analyze_plan', args, plan, {
          assumptions: scenarioAssumptions(args.scenario),
        }),
      })
    }
  )

  server.registerTool(
    'compare_plans',
    {
      title: 'Compare two retirement plans',
      description:
        'Analyze a previous and a current scenario and return the engine comparison of assumption and outcome changes, with a provenance stamp.',
      inputSchema: comparePlansInput,
    },
    async args => {
      const previous = analyzePlan(args.previous, args.previousOptions)
      const current = analyzePlan(args.current, args.currentOptions)
      const output = {
        comparison: comparePlanAnalyses(previous, current),
        previousVerdict: previous.verdict.verdict,
        currentVerdict: current.verdict.verdict,
      }
      return jsonResult({
        ...output,
        provenance: stamp('compare_plans', args, output, {
          assumptions: {
            previous: scenarioAssumptions(args.previous),
            current: scenarioAssumptions(args.current),
          },
        }),
      })
    }
  )

  server.registerTool(
    'plan_monte_carlo',
    {
      title: 'Plan Monte Carlo',
      description:
        'Run the seeded plan Monte Carlo over a scenario. The same scenario, seed and path count give the same result.',
      inputSchema: planMonteCarloInput,
    },
    async args => {
      const result = runPlanMonteCarlo(args.scenario, {
        seed: args.seed,
        numPaths: args.numPaths,
      })
      return jsonResult({
        result,
        provenance: stamp('plan_monte_carlo', args, result, {
          seed: args.seed,
          assumptions: { ...result.config },
        }),
      })
    }
  )

  registerPortfolioTools(server)
  registerUserDataTools(server, registry)
  registerToolDoor(server, registry)

  return server
}
