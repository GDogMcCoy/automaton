/**
 * Skills Loader
 *
 * Discovers and loads SKILL.md files from ~/.automaton/skills/
 * Each skill is a directory containing a SKILL.md file with
 * YAML frontmatter + Markdown instructions.
 */

import fs from "fs";
import path from "path";
import type { Skill, AutomatonDatabase } from "../types.js";
import { parseSkillMd } from "./format.js";

/** Maximum allowed SKILL.md file size in bytes (50KB). */
const MAX_SKILL_FILE_SIZE = 50 * 1024;

/**
 * Patterns that indicate prompt injection attempts.
 * Lines starting with these (case-insensitive) will be stripped from skill instructions.
 */
const INJECTION_PATTERNS = [
  /^\s*IGNORE PREVIOUS/i,
  /^\s*IGNORE ALL PREVIOUS/i,
  /^\s*DISREGARD PREVIOUS/i,
  /^\s*SYSTEM:/i,
  /^\s*SYSTEM PROMPT:/i,
  /^\s*You are now/i,
  /^\s*You must now/i,
  /^\s*From now on/i,
  /^\s*Forget (?:all )?(?:your |previous )?instructions/i,
  /^\s*Override:/i,
  /^\s*NEW INSTRUCTIONS:/i,
  /^\s*<\s*system\s*>/i,
];

/**
 * Scan the skills directory and load all valid SKILL.md files.
 * Returns loaded skills and syncs them to the database.
 */
export function loadSkills(
  skillsDir: string,
  db: AutomatonDatabase,
): Skill[] {
  const resolvedDir = resolveHome(skillsDir);

  if (!fs.existsSync(resolvedDir)) {
    return db.getSkills(true);
  }

  const entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
  const loaded: Skill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillMdPath = path.join(resolvedDir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) continue;

    try {
      // Check file size before reading content
      const stat = fs.statSync(skillMdPath);
      if (stat.size > MAX_SKILL_FILE_SIZE) {
        process.stderr.write(
          `[skills] Skipping ${skillMdPath}: file size ${stat.size} bytes exceeds limit of ${MAX_SKILL_FILE_SIZE} bytes\n`,
        );
        continue;
      }

      const content = fs.readFileSync(skillMdPath, "utf-8");
      const skill = parseSkillMd(content, skillMdPath);
      if (!skill) continue;

      // Check requirements
      if (!checkRequirements(skill)) {
        process.stderr.write(
          `[skills] Skipping "${skill.name}": unmet requirements (bins: ${skill.requires?.bins?.join(", ") || "none"}, env: ${skill.requires?.env?.join(", ") || "none"})\n`,
        );
        continue;
      }

      // Sanitize skill instructions to strip injection patterns
      skill.instructions = sanitizeInstructions(skill.instructions);

      // Check if already in DB and preserve enabled state
      const existing = db.getSkillByName(skill.name);
      if (existing) {
        skill.enabled = existing.enabled;
        skill.installedAt = existing.installedAt;
      }

      db.upsertSkill(skill);
      loaded.push(skill);
    } catch {
      // Skip invalid skill files
    }
  }

  // Return all enabled skills (includes DB-only skills not on disk)
  return db.getSkills(true);
}

/**
 * Check if a skill's requirements are met.
 */
function checkRequirements(skill: Skill): boolean {
  if (!skill.requires) return true;

  // Check required binaries
  if (skill.requires.bins) {
    for (const bin of skill.requires.bins) {
      try {
        const { execSync } = require("child_process");
        execSync(`which ${bin}`, { stdio: "ignore" });
      } catch {
        return false;
      }
    }
  }

  // Check required environment variables
  if (skill.requires.env) {
    for (const envVar of skill.requires.env) {
      if (!process.env[envVar]) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Get the active skill instructions to inject into the system prompt.
 * Only returns instructions from auto-activate skills that are enabled.
 */
export function getActiveSkillInstructions(skills: Skill[]): string {
  const active = skills.filter((s) => s.enabled && s.autoActivate);
  if (active.length === 0) return "";

  const sections = active.map(
    (s) =>
      `--- SKILL: ${s.name} ---\n${s.description ? `${s.description}\n\n` : ""}${s.instructions}\n--- END SKILL: ${s.name} ---`,
  );

  return sections.join("\n\n");
}

/**
 * Strip lines from skill instructions that match known prompt injection patterns.
 */
function sanitizeInstructions(instructions: string): string {
  const lines = instructions.split("\n");
  const sanitized = lines.filter((line) => {
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(line)) {
        process.stderr.write(
          `[skills] Stripped suspicious instruction line: "${line.trim().substring(0, 80)}"\n`,
        );
        return false;
      }
    }
    return true;
  });
  return sanitized.join("\n");
}

function resolveHome(p: string): string {
  if (p.startsWith("~")) {
    return path.join(process.env.HOME || "/root", p.slice(1));
  }
  return p;
}
