import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createSoilConfig, type SoilConfig, type SoilConfigInput } from "./config.js";
import { computeSoilChecksum } from "./checksum.js";
import { parseSoilMarkdownLoose } from "./io.js";
import { loadSoilIndexSnapshot } from "./index-store.js";
import {
  normalizeSoilId,
  normalizeSoilRelativePath,
  resolveSoilPageRelativePath,
  soilIdToRelativePath,
  soilPageRelativePathFromAbsolute,
} from "./paths.js";
import { SoilPageFrontmatterSchema, type SoilPageFrontmatter } from "./types.js";

export interface SoilDoctorFinding {
  code:
    | "invalid-frontmatter"
    | "duplicate-soil-id"
    | "unsafe-path"
    | "missing-source-path"
    | "checksum-mismatch"
    | "watermark-mismatch"
    | "missing-index"
    | "missing-required-page"
    | "index-page-count-mismatch"
    | "index-checksum-mismatch";
  severity: "error" | "warn";
  soilId?: string;
  relativePath: string;
  absolutePath: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface SoilDoctorReport {
  rootDir: string;
  totalPages: number;
  findings: SoilDoctorFinding[];
}

interface ScannedPage {
  relativePath: string;
  absolutePath: string;
  content: string;
  frontmatter: SoilPageFrontmatter | null;
  parseError: string | null;
}

export class SoilDoctor {
  constructor(private readonly config: SoilConfig) {}

  static create(configInput: SoilConfigInput = {}): SoilDoctor {
    return new SoilDoctor(createSoilConfig(configInput));
  }

  async inspect(): Promise<SoilDoctorReport> {
    const pages = await this.scanPages();
    const findings: SoilDoctorFinding[] = [];
    const bySoilId = new Map<string, ScannedPage[]>();
    const indexablePages = pages.filter((page) => page.parseError === null && page.frontmatter !== null);
    const indexSnapshot = await loadSoilIndexSnapshot(this.config);

    if (indexSnapshot === null) {
      findings.push({
        code: "missing-index",
        severity: "error",
        relativePath: path.relative(this.config.rootDir, this.config.indexPath) || this.config.indexPath,
        absolutePath: this.config.indexPath,
        message: "Soil index snapshot is missing",
      });
    } else {
      if (indexSnapshot.page_count !== indexablePages.length) {
        findings.push({
          code: "index-page-count-mismatch",
          severity: "warn",
          relativePath: path.relative(this.config.rootDir, this.config.indexPath) || this.config.indexPath,
          absolutePath: this.config.indexPath,
          message: "Indexed page count does not match the current Soil manifest",
          details: {
            indexed_page_count: indexSnapshot.page_count,
            actual_page_count: indexablePages.length,
          },
        });
      }

      const indexedByPath = new Map(indexSnapshot.pages.map((page) => [page.relative_path, page]));
      for (const page of indexablePages) {
        const frontmatter = page.frontmatter;
        if (frontmatter === null) {
          continue;
        }
        const indexedPage = indexedByPath.get(page.relativePath);
        const actualChecksum = computeSoilChecksum({
          frontmatter: this.withoutVolatileFields(frontmatter),
          body: parseSoilMarkdownLoose(page.content).body,
        });
        if (indexedPage === undefined) {
          findings.push({
            code: "index-checksum-mismatch",
            severity: "warn",
            soilId: frontmatter.soil_id,
            relativePath: page.relativePath,
            absolutePath: page.absolutePath,
            message: "Indexed page is missing from the Soil index snapshot",
            details: {
              indexedChecksum: null,
              actualChecksum,
            },
          });
          continue;
        }
        if (indexedPage.checksum !== actualChecksum) {
          findings.push({
            code: "index-checksum-mismatch",
            severity: "warn",
            soilId: frontmatter.soil_id,
            relativePath: page.relativePath,
            absolutePath: page.absolutePath,
            message: "Indexed checksum does not match the current page checksum",
            details: {
              indexedChecksum: indexedPage.checksum,
              actualChecksum,
            },
          });
        }
      }
    }

    for (const page of pages) {
      const frontmatter = page.frontmatter;
      if (page.parseError || frontmatter === null) {
        findings.push({
          code: "invalid-frontmatter",
          severity: "error",
          relativePath: page.relativePath,
          absolutePath: page.absolutePath,
          message: page.parseError ?? "Soil frontmatter is invalid",
        });
        continue;
      }

      let soilId: string;
      try {
        soilId = normalizeSoilId(frontmatter.soil_id);
      } catch (error) {
        findings.push({
          code: "unsafe-path",
          severity: "warn",
          relativePath: page.relativePath,
          absolutePath: page.absolutePath,
          message: `Unsafe soil_id path: ${frontmatter.soil_id}`,
          details: {
            soil_id: frontmatter.soil_id,
            error: error instanceof Error ? error.message : String(error),
          },
        });
        continue;
      }
      const records = bySoilId.get(soilId) ?? [];
      records.push(page);
      bySoilId.set(soilId, records);

      if (!this.isCanonicalPath(page.relativePath, soilId)) {
        findings.push({
          code: "unsafe-path",
          severity: "warn",
          soilId,
          relativePath: page.relativePath,
          absolutePath: page.absolutePath,
          message: `Page path does not match canonical soil_id path: ${soilIdToRelativePath(soilId)}`,
          details: { canonicalPath: soilIdToRelativePath(soilId) },
        });
      }

      const checksumMismatch = this.checkChecksumMismatch(page.content, frontmatter);
      if (checksumMismatch !== null) {
        findings.push({
          code: "checksum-mismatch",
          severity: "warn",
          soilId,
          relativePath: page.relativePath,
          absolutePath: page.absolutePath,
          message: checksumMismatch.message,
          details: checksumMismatch.details,
        });
      }

      const watermarkMismatch = await this.checkWatermarkMismatch(page, frontmatter);
      if (watermarkMismatch !== null) {
        findings.push({
          code: "watermark-mismatch",
          severity: "warn",
          soilId,
          relativePath: page.relativePath,
          absolutePath: page.absolutePath,
          message: watermarkMismatch.message,
          details: watermarkMismatch.details,
        });
      }

      findings.push(...(await this.checkSourcePaths(page, frontmatter)));
    }

    for (const [soilId, records] of bySoilId.entries()) {
      if (records.length < 2) {
        continue;
      }
      for (const record of records) {
        findings.push({
          code: "duplicate-soil-id",
          severity: "warn",
          soilId,
          relativePath: record.relativePath,
          absolutePath: record.absolutePath,
          message: `Duplicate soil_id detected: ${soilId}`,
          details: {
            duplicates: records.map((item) => item.relativePath),
          },
        });
      }
    }

    findings.push(...(await this.checkRequiredPages(pages)));

    return {
      rootDir: this.config.rootDir,
      totalPages: pages.length,
      findings,
    };
  }

  private async scanPages(): Promise<ScannedPage[]> {
    const pages: ScannedPage[] = [];
    await this.walk(this.config.rootDir, pages);
    return pages;
  }

  private async checkRequiredPages(pages: ScannedPage[]): Promise<SoilDoctorFinding[]> {
    const findings: SoilDoctorFinding[] = [];
    const existing = new Set(pages.map((page) => page.relativePath));
    const requiredPages = [
      { relativePath: "index.md", severity: "error" as const, message: "Required Soil entry page is missing: index.md" },
      {
        relativePath: "schedule/active.md",
        severity: "warn" as const,
        message: "Required active schedule page is missing: schedule/active.md",
      },
    ];

    for (const page of requiredPages) {
      if (existing.has(page.relativePath)) {
        continue;
      }
      const absolutePath = path.join(this.config.rootDir, page.relativePath);
      findings.push({
        code: "missing-required-page",
        severity: page.severity,
        relativePath: page.relativePath,
        absolutePath,
        message: page.message,
      });
    }

    return findings;
  }

  private async walk(dir: string, pages: ScannedPage[]): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walk(absolutePath, pages);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }
      const content = await fsp.readFile(absolutePath, "utf-8").catch(() => "");
      const relativePath = soilPageRelativePathFromAbsolute(this.config.rootDir, absolutePath);
      const parsed = parseSoilMarkdownLoose(content);
      const frontmatter = parsed.hasFrontmatter ? SoilPageFrontmatterSchema.safeParse(parsed.frontmatter) : null;
      pages.push({
        relativePath,
        absolutePath,
        content,
        frontmatter: frontmatter && frontmatter.success ? frontmatter.data : null,
        parseError: frontmatter && frontmatter.success ? null : this.describeParseError(content, frontmatter),
      });
    }
  }

  private describeParseError(content: string, parsed: ReturnType<typeof SoilPageFrontmatterSchema.safeParse> | null): string {
    if (!content.trim()) {
      return "Soil page is empty";
    }
    if (parsed === null || !("success" in parsed) || !parsed.success) {
      return "Soil frontmatter is invalid";
    }
    return "Soil frontmatter is invalid";
  }

  private isCanonicalPath(relativePath: string, soilId: string): boolean {
    try {
      return normalizeSoilRelativePath(relativePath) === resolveSoilPageRelativePath(soilId);
    } catch {
      return false;
    }
  }

  private checkChecksumMismatch(
    content: string,
    frontmatter: SoilPageFrontmatter
  ): { message: string; details?: Record<string, unknown> } | null {
    if (!frontmatter.checksum) {
      return null;
    }
    const computed = computeSoilChecksum({
      frontmatter: this.withoutVolatileFields(frontmatter),
      body: parseSoilMarkdownLoose(content).body,
    });
    if (computed === frontmatter.checksum) {
      return null;
    }
    return {
      message: "Stored checksum does not match page contents",
      details: { expected: frontmatter.checksum, actual: computed },
    };
  }

  private async checkWatermarkMismatch(
    page: ScannedPage,
    frontmatter: SoilPageFrontmatter
  ): Promise<{ message: string; details?: Record<string, unknown> } | null> {
    const watermark = frontmatter.generation_watermark;
    if (!watermark) {
      return null;
    }
    const sourcePaths = new Set<string>();
    if (watermark.source_path) {
      sourcePaths.add(watermark.source_path);
    }
    for (const sourcePath of watermark.source_paths ?? []) {
      sourcePaths.add(sourcePath);
    }

    const mismatches: Array<{ sourcePath: string; expected: string; actual: string }> = [];
    for (const sourcePath of sourcePaths) {
      const resolved = await this.resolveLocalSourcePath(page.absolutePath, sourcePath);
      if (resolved === null) {
        continue;
      }
      const expected = watermark.input_checksums?.[sourcePath] ?? watermark.source_hash ?? null;
      if (!expected) {
        continue;
      }
      const stat = await fsp.stat(resolved).catch(() => null);
      if (stat === null || !stat.isFile()) {
        continue;
      }
      const actual = await this.computeFileChecksum(resolved);
      if (actual !== expected) {
        mismatches.push({ sourcePath, expected, actual });
      }
    }

    if (mismatches.length === 0) {
      return null;
    }
    return {
      message: "Generation watermark source checksum mismatch",
      details: { mismatches },
    };
  }

  private async checkSourcePaths(page: ScannedPage, frontmatter: SoilPageFrontmatter): Promise<SoilDoctorFinding[]> {
    const findings: SoilDoctorFinding[] = [];
    const sourcePaths = new Set<string>();

    for (const sourceRef of frontmatter.source_refs ?? []) {
      sourcePaths.add(sourceRef.source_path);
      if (sourceRef.source_uri?.startsWith("file://")) {
        sourcePaths.add(fileURLToPath(sourceRef.source_uri));
      }
    }

    if (frontmatter.generation_watermark?.source_path) {
      sourcePaths.add(frontmatter.generation_watermark.source_path);
    }
    for (const sourcePath of frontmatter.generation_watermark?.source_paths ?? []) {
      sourcePaths.add(sourcePath);
    }

    for (const sourcePath of sourcePaths) {
      const resolved = await this.resolveLocalSourcePath(page.absolutePath, sourcePath);
      if (resolved === null) {
        continue;
      }
      const exists = await fsp.access(resolved).then(
        () => true,
        () => false
      );
      if (!exists) {
        findings.push({
          code: "missing-source-path",
          severity: "warn",
          soilId: frontmatter.soil_id,
          relativePath: page.relativePath,
          absolutePath: page.absolutePath,
          message: `Missing local source path: ${sourcePath}`,
          details: { sourcePath, resolvedPath: resolved },
        });
      }
    }

    return findings;
  }

  private async resolveLocalSourcePath(pagePath: string, sourcePath: string): Promise<string | null> {
    if (!sourcePath) {
      return null;
    }
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(sourcePath) && !sourcePath.startsWith("file://")) {
      return null;
    }
    if (sourcePath.startsWith("file://")) {
      return fileURLToPath(sourcePath);
    }
    if (path.isAbsolute(sourcePath)) {
      return path.resolve(sourcePath);
    }
    return path.resolve(path.dirname(pagePath), sourcePath);
  }

  private async computeFileChecksum(filePath: string): Promise<string> {
    const content = await fsp.readFile(filePath, "utf-8");
    return computeSoilChecksum(content);
  }

  private withoutVolatileFields(frontmatter: SoilPageFrontmatter): SoilPageFrontmatter {
    return SoilPageFrontmatterSchema.parse({
      ...frontmatter,
      checksum: undefined,
      generated_at: "1970-01-01T00:00:00.000Z",
      updated_at: "1970-01-01T00:00:00.000Z",
      generation_watermark: {
        ...frontmatter.generation_watermark,
        generated_at: "1970-01-01T00:00:00.000Z",
      },
    });
  }
}

export async function inspectSoilRoot(configInput: SoilConfigInput = {}): Promise<SoilDoctorReport> {
  return SoilDoctor.create(configInput).inspect();
}
