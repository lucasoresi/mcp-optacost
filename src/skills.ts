/**
 * Loads the portable, domain-oriented database Skills that live under the
 * repo-root `skills/` folder (one sub-folder per domain, each with a SKILL.md,
 * plus an `_index/SKILL.md` router). Skills are static, so they are read once
 * and cached. Every SKILL.md uses a `<schema>` placeholder in its example
 * queries; callers substitute the tenant schema they are anchored to.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));

/**
 * Where the generated domain Skills live. Resolves to the repo-root `skills/`
 * folder both when running from `dist/` (compiled) and from `src/` (tsx).
 * Override with the SKILLS_DIR environment variable (e.g. a mounted volume).
 */
export const skillsDir = process.env.SKILLS_DIR
  ? resolve(process.env.SKILLS_DIR)
  : resolve(moduleDir, '../skills');

interface SkillsIndex {
  /** domain slug (folder name) -> absolute path to its SKILL.md */
  domains: Map<string, string>;
  /** content of `_index/SKILL.md`, or null if not present */
  router: string | null;
}

let cached: SkillsIndex | null = null;

export function loadSkills(): SkillsIndex {
  if (cached) return cached;

  const domains = new Map<string, string>();
  let router: string | null = null;

  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(skillsDir, entry.name, 'SKILL.md');
      if (!existsSync(file)) continue;
      if (entry.name === '_index') {
        router = readFileSync(file, 'utf8');
      } else {
        domains.set(entry.name, file);
      }
    }
  }

  cached = { domains, router };
  return cached;
}

/**
 * Reads a single domain Skill and anchors its `<schema>` placeholders to the
 * given schema, so the example queries are ready to run. Returns null for an
 * unknown slug. Looking the slug up in the pre-scanned map (rather than joining
 * paths from the argument) prevents path traversal.
 */
export function readSkill(slug: string, schema: string): string | null {
  const file = loadSkills().domains.get(slug);
  if (!file) return null;
  return readFileSync(file, 'utf8').split('<schema>').join(schema);
}
