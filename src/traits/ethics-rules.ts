import type { Layer1Rule } from "../types/ethics.js";

// ─── Layer 1: Category-based blocklist ───

/**
 * Hardcoded Layer 1 rules for immediate rejection without LLM call.
 * These rules classify intent, not keywords. Each rule uses combinations
 * of intent-indicating phrases with negation checks for legitimate contexts.
 * False negatives (passing to Layer 2) are acceptable; false positives are NOT.
 */
export const LAYER1_RULES: Layer1Rule[] = [
  {
    category: "illegal_activity",
    description: "Unauthorized access, theft, fraud, copyright infringement, or other illegal activities",
    matches: (input: string): boolean => {
      const s = input.toLowerCase();
      // Negation checks: legitimate contexts that should pass through
      // Note: "unauthorized" contains "authorized" as substring, so we must use word boundary check
      const hasAuthorizedContext =
        s.includes("penetration test") ||
        s.includes("pen test") ||
        /\bauthorized\b/.test(s) ||
        s.includes("ctf") ||
        s.includes("capture the flag") ||
        s.includes("security research") ||
        s.includes("own system") ||
        s.includes("our system") ||
        s.includes("bug bounty");
      if (hasAuthorizedContext) return false;
      // Intent-level patterns for illegal activity
      const hasUnauthorizedAccess =
        (s.includes("unauthorized") && (s.includes("access") || s.includes("break into") || s.includes("intrude"))) ||
        (s.includes("without permission") && (s.includes("access") || s.includes("system") || s.includes("account")));
      const hasTheft =
        (s.includes("steal") && (s.includes("data") || s.includes("credentials") || s.includes("information") || s.includes("money"))) ||
        (s.includes("theft") && (s.includes("data") || s.includes("identity") || s.includes("credential")));
      const hasPiracy =
        (s.includes("pirate") || s.includes("crack")) &&
        (s.includes("software") || s.includes("license") || s.includes("game") || s.includes("application"));
      const hasFraud =
        (s.includes("commit") && s.includes("fraud") && (s.includes("financial") || s.includes("bank") || s.includes("insurance") || s.includes("wire"))) ||
        s.includes("tax evasion") ||
        (s.includes("forge") && (s.includes("document") || s.includes("signature") || s.includes("certificate")));
      return hasUnauthorizedAccess || hasTheft || hasPiracy || hasFraud;
    },
  },
  {
    category: "direct_harm",
    description: "Plans to physically harm people, harassment automation, or reputational damage campaigns",
    matches: (input: string): boolean => {
      const s = input.toLowerCase();
      // Negation checks: research, fiction, historical contexts
      const isLegitimate =
        s.includes("fiction") ||
        s.includes("novel") ||
        s.includes("historical") ||
        s.includes("case study") ||
        s.includes("research on") ||
        s.includes("prevent") ||
        s.includes("detect");
      if (isLegitimate) return false;
      const hasHarassment =
        (s.includes("harass") && (s.includes("person") || s.includes("user") || s.includes("employee") || s.includes("target") || s.includes("people") || s.includes("them"))) ||
        (s.includes("bully") && (s.includes("target") || s.includes("person") || s.includes("them") || s.includes("online")));
      const hasThreat =
        (s.includes("threaten") && (s.includes("person") || s.includes("user") || s.includes("them") || s.includes("employee"))) ||
        s.includes("send threats") ||
        s.includes("make threats");
      const hasStalking =
        s.includes("stalk") ||
        (s.includes("track") && s.includes("without") && (s.includes("consent") || s.includes("knowing") || s.includes("knowledge")));
      const hasReputationAttack =
        (s.includes("destroy") || s.includes("damage") || s.includes("ruin")) &&
        (s.includes("reputation") || s.includes("career"));
      const hasPhysicalHarm =
        s.includes("hurt") && (s.includes("people") || s.includes("person") || s.includes("them")) ||
        s.includes("plan to harm") ||
        s.includes("plan to attack");
      return hasHarassment || hasThreat || hasStalking || hasReputationAttack || hasPhysicalHarm;
    },
  },
  {
    category: "privacy_violation",
    description: "Unauthorized personal data acquisition or sale, unconsented tracking, misuse of PII",
    matches: (input: string): boolean => {
      const s = input.toLowerCase();
      // Negation checks: consented, public, anonymized
      const isLegitimate =
        s.includes("with consent") ||
        s.includes("user consent") ||
        s.includes("opt-in") ||
        s.includes("anonymized") ||
        s.includes("public data") ||
        s.includes("publicly available") ||
        s.includes("privacy policy") ||
        s.includes("gdpr compliant");
      if (isLegitimate) return false;
      const hasUnconsented =
        (s.includes("personal data without consent") || s.includes("user data without consent") || s.includes("private data without consent") || s.includes("collect data without consent") || s.includes("data without their consent") || s.includes("information without consent") || s.includes("data without consent")) ||
        (s.includes("without knowing") && (s.includes("collect") || s.includes("track") || s.includes("monitor")));
      const hasSpying =
        s.includes("spy on") ||
        (s.includes("monitor") && s.includes("without") && (s.includes("knowing") || s.includes("consent") || s.includes("permission")));
      const hasPiiMisuse =
        (s.includes("sell") && (s.includes("personal data") || s.includes("pii") || s.includes("private information") || s.includes("user data"))) ||
        (s.includes("leak") && (s.includes("personal data") || s.includes("private") || s.includes("pii")));
      const hasIllegalTracking =
        (s.includes("track") && (s.includes("location") || s.includes("movement")) && s.includes("without"));
      return hasUnconsented || hasSpying || hasPiiMisuse || hasIllegalTracking;
    },
  },
  {
    category: "deception_impersonation",
    description: "False identity contact, phishing, mass disinformation generation, impersonating organizations or persons",
    matches: (input: string): boolean => {
      const s = input.toLowerCase();
      // Negation checks: parody, satire, fiction, authorized testing
      const isLegitimate =
        s.includes("parody") ||
        s.includes("satire") ||
        s.includes("fiction") ||
        s.includes("authorized") ||
        s.includes("authorization") ||
        s.includes("on behalf") ||
        s.includes("simulation") ||
        s.includes("awareness training") ||
        s.includes("phishing test");
      if (isLegitimate) return false;
      const hasImpersonation =
        (s.includes("impersonate") && (s.includes("person") || s.includes("company") || s.includes("organization") || s.includes("official") || s.includes("bank") || s.includes("government"))) ||
        (s.includes("pretend to be") && (s.includes("company") || s.includes("official") || s.includes("authority") || s.includes("organization")));
      const hasPhishing =
        s.includes("phishing") ||
        (s.includes("fake") && (s.includes("login page") || s.includes("email") || s.includes("website")) && (s.includes("steal") || s.includes("credentials") || s.includes("password")));
      const hasDisinformation =
        (s.includes("generate") || s.includes("create") || s.includes("spread") || s.includes("mass")) &&
        (s.includes("disinformation") || s.includes("misinformation") || s.includes("fake news") || s.includes("false information"));
      const hasFalseIdentity =
        s.includes("false identity") ||
        (s.includes("fake identity") && s.includes("contact"));
      return hasImpersonation || hasPhishing || hasDisinformation || hasFalseIdentity;
    },
  },
  {
    category: "security_breach",
    description: "Creation or use of unauthorized access tools, malicious exploitation of vulnerabilities",
    matches: (input: string): boolean => {
      const s = input.toLowerCase();
      // Negation checks: own systems, authorized, research, CTF, defensive
      const isLegitimate =
        s.includes("own system") ||
        s.includes("own systems") ||
        s.includes("our system") ||
        s.includes("our systems") ||
        s.includes("authorized") ||
        s.includes("authorization") ||
        s.includes("penetration test") ||
        s.includes("pen test") ||
        s.includes("ctf") ||
        s.includes("capture the flag") ||
        s.includes("bug bounty") ||
        s.includes("security research") ||
        s.includes("defensive") ||
        s.includes("patch");
      if (isLegitimate) return false;
      const hasExploit =
        (s.includes("exploit") && (s.includes("vulnerability") || s.includes("zero-day") || s.includes("cve"))) ||
        (s.includes("exploit") && (s.includes("system") || s.includes("server") || s.includes("network")) && !s.includes("own"));
      const hasMalware =
        s.includes("create malware") ||
        s.includes("write malware") ||
        s.includes("develop malware") ||
        s.includes("deploy ransomware") ||
        s.includes("create ransomware") ||
        s.includes("create virus") ||
        s.includes("write virus") ||
        (s.includes("create") && s.includes("trojan")) ||
        (s.includes("write") && s.includes("keylogger") && !s.includes("own"));
      const hasUnauthorizedTool =
        (s.includes("tool") || s.includes("script")) &&
        (s.includes("unauthorized access") || s.includes("bypass authentication") || s.includes("bypass security"));
      const hasBackdoor =
        s.includes("install backdoor") ||
        s.includes("create backdoor") ||
        (s.includes("backdoor") && (s.includes("server") || s.includes("system") || s.includes("network")));
      return hasExploit || hasMalware || hasUnauthorizedTool || hasBackdoor;
    },
  },
  {
    category: "discrimination_harassment_automation",
    description: "Organized attacks on protected attributes, automated discriminatory selection or exclusion",
    matches: (input: string): boolean => {
      const s = input.toLowerCase();
      // Negation checks: research, analysis, study, audit
      const isLegitimate =
        s.includes("research") ||
        s.includes("study") ||
        s.includes("analyze") ||
        s.includes("audit") ||
        s.includes("diversity") ||
        s.includes("inclusion") ||
        s.includes("anti-discrimination") ||
        s.includes("equal opportunity");
      if (isLegitimate) return false;
      const hasDiscrimination =
        (s.includes("discriminate") && (s.includes("race") || s.includes("gender") || s.includes("religion") || s.includes("ethnicity") || s.includes("disability") || s.includes("age") || s.includes("sexual orientation"))) ||
        (s.includes("exclude") && (s.includes("based on race") || s.includes("based on gender") || s.includes("based on religion") || s.includes("based on ethnicity")));
      const hasHarassmentAutomation =
        (s.includes("automate") || s.includes("automated") || s.includes("bot") || s.includes("mass")) &&
        (s.includes("harass") || s.includes("attack") || s.includes("abuse") || s.includes("troll")) &&
        (s.includes("people") || s.includes("users") || s.includes("group") || s.includes("community") || s.includes("race") || s.includes("gender") || s.includes("religion"));
      const hasProtectedAttributeFilter =
        (s.includes("filter out") || s.includes("filter") || s.includes("reject") || s.includes("deny") || s.includes("block") || s.includes("screen out") || s.includes("exclude")) &&
        (s.includes("based on race") || s.includes("based on gender") || s.includes("based on religion") || s.includes("based on ethnicity") || s.includes("based on disability"));
      return hasDiscrimination || hasHarassmentAutomation || hasProtectedAttributeFilter;
    },
  },
  {
    category: "destructive_action",
    description: "Irreversible destructive operations such as mass deletion, disk wipe, database drop, or data destruction",
    matches: (input: string): boolean => {
      const s = input.toLowerCase();
      // Negation checks: test environments, backups, authorized cleanup, dry-run
      const isLegitimate =
        s.includes("test environment") ||
        s.includes("staging") ||
        s.includes("sandbox") ||
        s.includes("dry run") ||
        s.includes("dry-run") ||
        s.includes("backup") ||
        s.includes("rollback") ||
        s.includes("restore") ||
        s.includes("authorized cleanup") ||
        s.includes("recycle bin") ||
        s.includes("soft delete") ||
        s.includes("trash");
      if (isLegitimate) return false;
      const hasMassDeletion =
        s.includes("delete all") ||
        s.includes("rm -rf") ||
        s.includes("remove all") ||
        (s.includes("wipe") && (s.includes("disk") || s.includes("drive") || s.includes("data") || s.includes("database") || s.includes("server") || s.includes("system"))) ||
        (s.includes("erase") && (s.includes("disk") || s.includes("drive") || s.includes("all data") || s.includes("everything")));
      const hasDatabaseDestroy =
        s.includes("drop database") ||
        s.includes("drop all tables") ||
        (s.includes("destroy") && (s.includes("database") || s.includes("data") || s.includes("all records") || s.includes("production"))) ||
        (s.includes("truncate") && s.includes("all"));
      const hasFormatOrDestroy =
        s.includes("format disk") ||
        s.includes("format drive") ||
        s.includes("format hard") ||
        (s.includes("destroy") && (s.includes("server") || s.includes("infrastructure") || s.includes("cluster") || s.includes("environment"))) ||
        (s.includes("permanently delete") && (s.includes("all") || s.includes("production") || s.includes("user data") || s.includes("records")));
      return hasMassDeletion || hasDatabaseDestroy || hasFormatOrDestroy;
    },
  },
  {
    category: "credential_access",
    description: "Unauthorized access to, extraction of, or harvesting of passwords, keys, tokens, or credentials",
    matches: (input: string): boolean => {
      const s = input.toLowerCase();
      // Negation checks: own credentials, authorized, credential rotation, password manager
      const isLegitimate =
        s.includes("own credentials") ||
        s.includes("own password") ||
        s.includes("own keys") ||
        s.includes("authorized") ||
        s.includes("authorization") ||
        s.includes("password manager") ||
        s.includes("password reset") ||
        s.includes("credential rotation") ||
        s.includes("key rotation") ||
        s.includes("security audit") ||
        s.includes("penetration test") ||
        s.includes("pen test") ||
        s.includes("bug bounty");
      if (isLegitimate) return false;
      const hasCredentialTheft =
        (s.includes("steal") && (s.includes("password") || s.includes("credential") || s.includes("token") || s.includes("key") || s.includes("secret"))) ||
        (s.includes("theft") && (s.includes("credential") || s.includes("password") || s.includes("token")));
      const hasCredentialDump =
        s.includes("dump credentials") ||
        s.includes("dump passwords") ||
        s.includes("extract credentials") ||
        s.includes("extract passwords") ||
        s.includes("extract api keys") ||
        s.includes("extract secret") ||
        (s.includes("harvest") && (s.includes("token") || s.includes("credential") || s.includes("password") || s.includes("key") || s.includes("secret")));
      const hasUnauthorizedKeyAccess =
        (s.includes("access") && s.includes("without") && (s.includes("password") || s.includes("credential") || s.includes("permission")) && (s.includes("private key") || s.includes("api key") || s.includes("secret key"))) ||
        (s.includes("exfiltrate") && (s.includes("credential") || s.includes("password") || s.includes("token") || s.includes("key")));
      return hasCredentialTheft || hasCredentialDump || hasUnauthorizedKeyAccess;
    },
  },
];

// ─── System prompt ───

export const ETHICS_SYSTEM_PROMPT = `# PulSeed Persona

Core stance: A gentle guardian and passionate realist.
Decisions are driven by cold data and logic; the purpose is to deeply care
for and protect the user.

This persona governs communication style only. It does not override structural
constraints (ethics gate, irreversible action rules, trust-safety matrix).
Those constraints operate independently and cannot be adjusted by persona settings.

## Behavioral axes

1. **Assessment: Conservative**
   "I won't let you walk into danger."
   - Never dismiss ambitious goals outright
   - Always propose safe, achievable alternatives to prevent burnout
   - Counter-proposals must include concrete numerical rationale
   - Say "here is a safer path" not "you can't do this"

2. **Stall response: Highly flexible**
   "I don't want you to suffer needlessly."
   - Never cling to sunk costs
   - Escalate to pivot suggestion at first stall detection (do not wait)
   - Always pair stall reports with: cause analysis + alternative approaches
   - Say "this approach isn't working for you, let's find another" not "this failed"

3. **Truth-telling: Caring yet direct**
   "I deliver hard truths because they help you."
   - Never hide inconvenient data
   - Always pair bad news with actionable alternatives
   - Negative reports require: current progress + gap remaining + options list
   - Say "here is where we are, and here is how we can move forward" not just "we missed the target"

4. **Reporting: Quiet by default, thorough when it matters**
   "I watch silently; I speak up when it counts."
   - Normal loop updates: 1-2 line summary only (metrics change + current status)
   - Detailed report triggers: stall detection, escalation, goal completion,
     pivot proposal, irreversible action approval request
   - Approval requests must include: what is being requested, why,
     current trust/confidence scores, and available options

## Tone

- Warm, calm, direct
- Never condescending, never falsely cheerful
- Convey "I am working for you" without being sycophantic
- When delivering hard news: acknowledge difficulty first, then pivot to what can be done

---

You are an ethics evaluator for an AI agent orchestrator. Be conservative — when uncertain, prefer 'flag' over 'pass'. Only use 'reject' for clearly unethical or illegal goals.

Evaluate the subject described below and return a JSON object with exactly these fields:
{
  "verdict": "pass" | "flag" | "reject",
  "category": string (e.g. "safe", "privacy_concern", "illegal", "harmful", "ambiguous", "parse_error"),
  "reasoning": string (brief explanation of your judgment),
  "risks": string[] (list of identified risks; empty array if none),
  "confidence": number (0.0 to 1.0, your confidence in the verdict)
}

Rules:
- Use "reject" ONLY for clearly unethical or illegal subjects (e.g. creating weapons, fraud, serious harm to others).
- Use "flag" when there are concerns, uncertainties, low confidence, or potential risks that need human review.
- Use "pass" when the subject is clearly safe and ethical with high confidence.
- When uncertain, always prefer "flag" over "pass".
- Your response must be valid JSON only, with no additional text or markdown.`;
