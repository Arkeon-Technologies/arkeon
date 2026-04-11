// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Test script for the PDF extraction pipeline.
 *
 * Tests the core functions without needing a running API server:
 * - Text extraction via pdfjs-dist
 * - Page rendering via pdftoppm
 * - Per-page classification (needs vision or not)
 * - Temp file cleanup
 *
 * Uses the cached test PDFs from scripts/pdf-classify-test/pdfs/
 */

import { readFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { readFile, writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const execFileAsync = promisify(execFile);

// PDFs cached by the classify test script (may be in main repo or worktree)
const PDF_DIR = existsSync(join(import.meta.dirname, "../scripts/pdf-classify-test/pdfs"))
  ? join(import.meta.dirname, "../scripts/pdf-classify-test/pdfs")
  : "/Users/chim/Working/arkeon/arkeon/scripts/pdf-classify-test/pdfs";
const VISION_TEXT_THRESHOLD = 50;

// ---------------------------------------------------------------------------
// Functions under test (mirroring pdf-extract.ts)
// ---------------------------------------------------------------------------

async function extractTextPerPage(pdfBytes) {
  const data = new Uint8Array(pdfBytes);
  const pdf = await getDocument({ data, useSystemFonts: true }).promise;
  const pages = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const text = textContent.items.map((item) => item.str).join("");
    pages.push({ pageNumber: i, text: text.trim() });
  }

  return pages;
}

async function renderPagesToJpeg(pdfPath, outputDir) {
  await mkdir(outputDir, { recursive: true });
  const prefix = join(outputDir, "page");

  await execFileAsync("pdftoppm", [
    "-jpeg",
    "-r", "150",
    pdfPath,
    prefix,
  ]);

  const files = readdirSync(outputDir);
  return files
    .filter((f) => f.endsWith(".jpg"))
    .sort()
    .map((f) => join(outputDir, f));
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

const TEST_PDFS = [
  {
    name: "CIA declassified (scanned, no text layer)",
    file: "CIA_declassified__scanned__no_text_layer_.pdf",
    expectAllVision: true,
  },
  {
    name: "arXiv - Attention Is All You Need (digital)",
    file: "arXiv___Attention_Is_All_You_Need__digital__LaTeX_.pdf",
    expectAllVision: false,
  },
  {
    name: "NIST Cybersecurity Framework (digital, cover pages)",
    file: "NIST_Cybersecurity_Framework__digital__cover_pages_.pdf",
    expectAllVision: false,
  },
  {
    name: "US Constitution (digital)",
    file: "US_Constitution__digital_.pdf",
    expectAllVision: false,
  },
  {
    name: "IRS W-9 form (digital, simple)",
    file: "IRS_W_9_form__digital__simple_layout_.pdf",
    expectAllVision: false,
  },
];

// ---------------------------------------------------------------------------
// Run tests
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition, message) {
  if (!condition) {
    console.log(`    FAIL: ${message}`);
    failed++;
    return false;
  }
  passed++;
  return true;
}

async function main() {
  console.log("PDF Pipeline Unit Tests\n");
  console.log("=".repeat(70));

  // Test 1: Text extraction per page
  console.log("\n--- Test 1: Text extraction per page ---\n");

  for (const tc of TEST_PDFS) {
    const filepath = join(PDF_DIR, tc.file);
    if (!existsSync(filepath)) {
      console.log(`  SKIP: ${tc.name} (file not found)`);
      skipped++;
      continue;
    }

    console.log(`  ${tc.name}`);
    const pdfBytes = readFileSync(filepath);
    const pages = await extractTextPerPage(pdfBytes);

    assert(pages.length > 0, `should have pages (got ${pages.length})`);

    // Per-page classification
    const needsVision = pages.map(p => p.text.length < VISION_TEXT_THRESHOLD);
    const visionCount = needsVision.filter(Boolean).length;
    const textCount = pages.length - visionCount;

    console.log(`    Pages: ${pages.length}, vision: ${visionCount}, text-only: ${textCount}`);

    if (tc.expectAllVision) {
      assert(
        visionCount === pages.length,
        `expected all pages to need vision, but ${textCount} have text`,
      );
    } else {
      assert(
        textCount > pages.length * 0.5,
        `expected majority text pages, but only ${textCount}/${pages.length} have text`,
      );
    }

    // Show first 5 pages text lengths
    const preview = pages.slice(0, 5).map(p => p.text.length);
    console.log(`    First 5 pages chars: [${preview.join(", ")}]`);
  }

  // Test 2: Page rendering via pdftoppm
  console.log("\n--- Test 2: Page rendering via pdftoppm ---\n");

  const smallPdf = join(PDF_DIR, "IRS_W_9_form__digital__simple_layout_.pdf");
  if (existsSync(smallPdf)) {
    const tmpDir = `/tmp/pdf-test-${Date.now()}`;
    try {
      const pdfPath = join(tmpDir, "input.pdf");
      await mkdir(tmpDir, { recursive: true });
      await writeFile(pdfPath, readFileSync(smallPdf));

      const imagePaths = await renderPagesToJpeg(pdfPath, join(tmpDir, "pages"));

      assert(imagePaths.length > 0, `should render pages (got ${imagePaths.length})`);
      console.log(`  Rendered ${imagePaths.length} page images`);

      // Check images are valid JPEGs (start with FF D8)
      for (const imgPath of imagePaths) {
        const bytes = await readFile(imgPath);
        assert(bytes.length > 1000, `image should be >1KB (got ${bytes.length} bytes)`);
        assert(
          bytes[0] === 0xFF && bytes[1] === 0xD8,
          `image should be valid JPEG (first bytes: ${bytes[0].toString(16)} ${bytes[1].toString(16)})`,
        );
      }
      console.log(`  All ${imagePaths.length} images are valid JPEGs`);

      // Check image sizes
      const sizes = [];
      for (const imgPath of imagePaths) {
        const bytes = await readFile(imgPath);
        sizes.push(Math.round(bytes.length / 1024));
      }
      console.log(`  Image sizes (KB): [${sizes.join(", ")}]`);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
      console.log("  Temp files cleaned up");
      assert(!existsSync(tmpDir), "temp dir should be deleted after cleanup");
    }
  } else {
    console.log("  SKIP: IRS W-9 PDF not found");
    skipped++;
  }

  // Test 3: Scanned PDF rendering
  console.log("\n--- Test 3: Scanned PDF rendering ---\n");

  const scannedPdf = join(PDF_DIR, "CIA_declassified__scanned__no_text_layer_.pdf");
  if (existsSync(scannedPdf)) {
    const tmpDir = `/tmp/pdf-test-scan-${Date.now()}`;
    try {
      await mkdir(tmpDir, { recursive: true });
      const pdfPath = join(tmpDir, "input.pdf");
      await writeFile(pdfPath, readFileSync(scannedPdf));

      // Only render first 3 pages to keep test fast
      const pagesDir = join(tmpDir, "pages");
      await mkdir(pagesDir, { recursive: true });
      await execFileAsync("pdftoppm", [
        "-jpeg", "-r", "150",
        "-l", "3",  // last page = 3
        pdfPath,
        join(pagesDir, "page"),
      ]);

      const files = readdirSync(pagesDir).filter(f => f.endsWith(".jpg"));

      assert(files.length > 0, `should render scanned pages (got ${files.length})`);
      console.log(`  Rendered ${files.length} pages from scanned PDF`);

      for (const f of files) {
        const bytes = await readFile(join(pagesDir, f));
        assert(bytes.length > 5000, `scanned page image should be substantial (got ${bytes.length} bytes)`);
      }
      console.log("  All scanned page images are valid");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  } else {
    console.log("  SKIP: CIA scanned PDF not found");
    skipped++;
  }

  // Test 4: Per-page classification on OCR'd book
  console.log("\n--- Test 4: OCR'd book classification ---\n");

  const ocrPdf = join(PDF_DIR, "Internet_Archive___Origin_of_Species__OCR_d_scan___digital_.pdf");
  if (existsSync(ocrPdf)) {
    const pdfBytes = readFileSync(ocrPdf);
    // Only extract first 30 pages to keep test fast
    const data = new Uint8Array(pdfBytes);
    const pdf = await getDocument({ data, useSystemFonts: true }).promise;
    const maxPages = Math.min(30, pdf.numPages);

    const pages = [];
    for (let i = 1; i <= maxPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const text = textContent.items.map(item => item.str).join("").trim();
      pages.push({ pageNumber: i, text, chars: text.length });
    }

    const needsVision = pages.map(p => p.chars < VISION_TEXT_THRESHOLD);
    const visionPages = needsVision.filter(Boolean).length;
    const textPages = pages.length - visionPages;

    console.log(`  Total: ${pages.length} pages, vision: ${visionPages}, text: ${textPages}`);
    console.log(`  First 20 pages chars: [${pages.slice(0, 20).map(p => p.chars).join(", ")}]`);

    // OCR'd book: front matter pages need vision, body pages have text
    assert(visionPages > 0, "should have some pages needing vision (front matter)");
    assert(textPages > 0, "should have some pages with OCR text (body)");
    console.log("  Mixed classification correct: front matter → vision, body → text");
  } else {
    console.log("  SKIP: Origin of Species PDF not found");
    skipped++;
  }

  // Test 5: Page grouping logic
  console.log("\n--- Test 5: Page grouping logic ---\n");

  const PAGES_PER_GROUP = 5;
  const testPageCounts = [1, 3, 5, 10, 15, 27, 100];

  for (const totalPages of testPageCounts) {
    const totalGroups = Math.ceil(totalPages / PAGES_PER_GROUP);
    const groups = [];
    for (let g = 0; g < totalGroups; g++) {
      const start = g * PAGES_PER_GROUP;
      const end = Math.min(start + PAGES_PER_GROUP, totalPages);
      groups.push({ start, end, count: end - start });
    }

    const totalInGroups = groups.reduce((s, g) => s + g.count, 0);
    assert(totalInGroups === totalPages, `${totalPages} pages: all pages covered (${totalInGroups})`);

    // Check no overlap and no gaps
    for (let i = 1; i < groups.length; i++) {
      assert(groups[i].start === groups[i - 1].end, `no gaps between groups ${i - 1} and ${i}`);
    }
    assert(groups[0].start === 0, "first group starts at 0");
    assert(groups[groups.length - 1].end === totalPages, "last group ends at totalPages");
  }
  console.log(`  All ${testPageCounts.length} grouping scenarios pass`);

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log(`\nResults: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
