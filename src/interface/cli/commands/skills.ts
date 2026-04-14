import { parseArgs } from "node:util";
import { SkillRegistry } from "../../../runtime/skills/skill-registry.js";
import { formatOperationError } from "../utils.js";

export async function cmdSkills(argv: string[], registry = new SkillRegistry({ workspaceRoot: process.cwd() })): Promise<number> {
  const subcommand = argv[0] ?? "list";

  if (subcommand === "list") {
    const skills = await registry.list();
    if (skills.length === 0) {
      console.log("No skills found. Use `pulseed skills install <path-to-SKILL.md>`.");
      return 0;
    }
    console.log(`Found ${skills.length} skill(s):\n`);
    console.log(`${"ID".padEnd(28)} ${"SOURCE".padEnd(10)} DESCRIPTION`);
    console.log("-".repeat(80));
    for (const skill of skills) {
      const description = skill.description.length > 48
        ? `${skill.description.slice(0, 45)}...`
        : skill.description;
      console.log(`${skill.id.padEnd(28)} ${skill.source.padEnd(10)} ${description}`);
    }
    return 0;
  }

  if (subcommand === "search") {
    const query = argv.slice(1).join(" ").trim();
    if (!query) {
      console.error("Error: query is required. Usage: pulseed skills search <query>");
      return 1;
    }
    const skills = await registry.search(query);
    for (const skill of skills) {
      console.log(`${skill.id}\t${skill.source}\t${skill.description}`);
    }
    if (skills.length === 0) console.log("No matching skills found.");
    return 0;
  }

  if (subcommand === "show") {
    const id = argv[1];
    if (!id) {
      console.error("Error: skill id is required. Usage: pulseed skills show <id>");
      return 1;
    }
    const result = await registry.read(id);
    if (!result) {
      console.error(`Error: skill "${id}" not found.`);
      return 1;
    }
    console.log(result.body);
    return 0;
  }

  if (subcommand === "install") {
    let parsed: { values: { namespace?: string; force?: boolean }; positionals: string[] };
    try {
      parsed = parseArgs({
        args: argv.slice(1),
        options: {
          namespace: { type: "string" },
          force: { type: "boolean" },
        },
        allowPositionals: true,
        strict: false,
      }) as { values: { namespace?: string; force?: boolean }; positionals: string[] };
    } catch (err) {
      console.error(formatOperationError("parse skills install arguments", err));
      return 1;
    }
    const source = parsed.positionals[0];
    if (!source) {
      console.error("Error: source path is required. Usage: pulseed skills install <path-to-SKILL.md> [--namespace <name>] [--force]");
      return 1;
    }
    try {
      const skill = await registry.install(source, {
        namespace: parsed.values.namespace,
        force: parsed.values.force,
      });
      console.log(`Skill "${skill.id}" installed.`);
      return 0;
    } catch (err) {
      console.error(formatOperationError("install skill", err));
      return 1;
    }
  }

  console.error(`Unknown skills subcommand: "${subcommand}"`);
  console.error("Available: skills list, skills search, skills show, skills install");
  return 1;
}
