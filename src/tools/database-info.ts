import { renderRecords } from "../format.js";
import { guarded, textResult, type ToolContext, type ToolResult } from "./shared.js";

export function databaseInfoDescription(): string {
  return 'Show what this server is connected to and which read-only safety checks passed at startup. Use this to tell the user exactly what access is in effect.';
}

export async function databaseInfo(context: ToolContext): Promise<ToolResult> {
  return guarded(async () => {
    const { report, config, schema } = context;

    const warnings = report.checks.filter((check) => !check.passed);

    const sections = [
      '## Connection',
      '',
      renderRecords(
        ['setting', 'value'],
        [
          { setting: 'database', value: report.database },
          { setting: 'role', value: report.role },
          { setting: 'server version', value: report.serverVersion },
          { setting: 'anchored schema', value: schema },
          { setting: 'max rows per query', value: String(config.maxRows) },
          { setting: 'statement timeout', value: `${config.statementTimeoutMs} ms` },
          {
            setting: 'mode',
            value: config.allowWritableRole ? 'permissive (ALLOW_WRITABLE_ROLE=true)' : 'strict',
          },
        ],
      ),
      '',
      '## Read-only enforcement',
      '',
      'Every query runs inside `BEGIN TRANSACTION READ ONLY` and is always rolled back. Statements are restricted to a single read-only command by a lexical guard, and the connected role was audited at startup:',
      '',
      renderRecords(
        ['check', 'result', 'detail'],
        report.checks.map((check) => ({
          check: check.name,
          result: check.passed ? 'pass' : check.severity === 'warning' ? 'WARNING' : 'FAIL',
          detail: check.detail,
        })),
      ),
    ];

    if (warnings.length > 0) {
      sections.push(
        '',
        `${warnings.length} check(s) did not pass but were downgraded to warnings by ALLOW_WRITABLE_ROLE. Writes are still blocked by the read-only transaction, but the role itself is more privileged than this server would prefer.`,
      );
    }

    return textResult(sections.join('\n'));
  });
}
