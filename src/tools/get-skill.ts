import { z } from "zod";

import { loadSkills, readSkill } from "../skills.js";
import { errorResult, guarded, textResult, type ToolContext, type ToolResult } from "./shared.js";

export const getSkillInputSchema = {
  domain: z
    .string()
    .describe('Domain slug, e.g. "cost-composition" or "practice-pricing". Use list_database_domains to see the options.'),
};

export function getDatabaseSkillDescription(context: ToolContext): string {
  return (
    `Load the knowledge Skill for one database domain: its tables, validated relationships, key concepts, ` +
    `metrics, semantic rules, gotchas and ready-to-run example queries — already anchored to the ` +
    `"${context.schema}" schema. Call list_database_domains first to choose a domain.`
  );
}

export async function getDatabaseSkill(
  context: ToolContext,
  args: { domain: string },
): Promise<ToolResult> {
  return guarded(async () => {
    const content = readSkill(args.domain.trim(), context.schema);
    if (content) {
      return textResult(content);
    }
    const { domains } = loadSkills();
    return errorResult(
      `Unknown domain "${args.domain}". Available: ${[...domains.keys()].sort().join(', ') || '(none installed)'}.`,
    );
  });
}
