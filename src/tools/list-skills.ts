import { loadSkills } from "../skills.js";
import { guarded, textResult, type ToolContext, type ToolResult } from "./shared.js";

export function listDatabaseDomainsDescription(context: ToolContext): string {
  return (
    `List the business domains of the "${context.schema}" database and when to use each. ` +
    `Call this FIRST: pick the relevant domain for the question, then call get_database_skill ` +
    `to load its tables, relationships, semantic rules and validated example queries before writing SQL.`
  );
}

export async function listDatabaseDomains(context: ToolContext): Promise<ToolResult> {
  return guarded(async () => {
    const { router, domains } = loadSkills();
    if (router) {
      return textResult(router.split('<schema>').join(context.schema));
    }
    if (domains.size === 0) {
      return textResult('No database domain skills are installed on this server.');
    }
    return textResult(
      [
        'Available database domains (call get_database_skill with one of these slugs):',
        '',
        ...[...domains.keys()].sort().map((d) => `- ${d}`),
      ].join('\n'),
    );
  });
}
