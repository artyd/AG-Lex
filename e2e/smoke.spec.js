// AG Lex e2e smoke. Backend runs with AGLEX_MOCK_AI=1 so analyze / reconcile
// / chat return canned fixtures (see legal_app/backend/mock_ai.py). Tests
// run serially in one worker on a fresh DB (globalSetup wipes the file).
import { test, expect } from '@playwright/test';
import { FIXTURES, login } from './support.js';

test.describe.configure({ mode: 'serial' });

test('login lands on dashboard', async ({ page }) => {
  await login(page);
  // Sidebar is the most reliable post-auth landmark.
  await expect(page.locator('.app')).toBeVisible();
});

test('upload contract → see real analysis with highlights and law chips', async ({ page }) => {
  await login(page);

  // Open the launcher modal from the sidebar.
  await page.locator('.app .sidebar button.btn-primary').first().click();
  // Modal: pick the contract block. Both hub blocks share .hub-block; the
  // first one is the contract path (App.jsx renders them in that order).
  const hubContract = page.locator('.hub-block').nth(0);
  await expect(hubContract).toBeVisible();
  await hubContract.click();

  // Contract upload modal. The hidden <input type=file> is right there.
  const fileInput = page.locator('input[type="file"][accept*=".docx"]').first();
  await fileInput.setInputFiles(FIXTURES.contract);

  // The "Analyze / Аналізувати" button is the primary CTA in the modal.
  // It enables once a file is selected.
  const analyzeBtn = page.locator('.modal .btn-primary').last();
  await expect(analyzeBtn).toBeEnabled({ timeout: 10_000 });
  await analyzeBtn.click();

  // Phase 4.x PR4: contract upload now mounts AnalysisView →
  //   - .analysis shell + .aipanel-head right panel
  //   - .pdf-viewer canvas (PdfViewer) for the source document
  //   - .hl-rect overlay (pdfHighlight anchored mock finding quotes)
  //   - .finding cards with .law-chip on the right side.
  await expect(page.locator('.analysis')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.aipanel-head')).toBeVisible({ timeout: 30_000 });
  await expect(
    page.locator('.pdf-viewer canvas[data-pdf-canvas]').first(),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.hl-rect').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.finding').first()).toBeVisible();
  await expect(page.locator('.finding .law-chip').first()).toBeVisible();
});

test('upload contract + handover pair → see reconciliation result', async ({ page }) => {
  await login(page);
  await page.locator('.app .sidebar button.btn-primary').first().click();
  // Second hub block opens the pair-upload modal.
  const hubCompare = page.locator('.hub-block').nth(1);
  await hubCompare.click();

  // Pair modal has two square slots — distinct file inputs by accept.
  const contractInput = page.locator('.modal input[type="file"][accept=".pdf,.docx"]').first();
  const handoverInput = page.locator('.modal input[type="file"][accept=".pdf,.docx,.xlsx"]').first();
  await contractInput.setInputFiles(FIXTURES.contractPair);
  await handoverInput.setInputFiles(FIXTURES.handover);

  const runBtn = page.locator('.modal .btn-primary').last();
  await expect(runBtn).toBeEnabled({ timeout: 10_000 });
  // Wait on the API response so we don't race the "modal closes + route changes"
  // transition on slow machines.
  const reconcileResp = page.waitForResponse(r => r.url().includes('/api/reconcile') && r.request().method() === 'POST');
  await runBtn.click();
  await reconcileResp;

  // Phase 4.x PR4: reconcile result uses AnalysisView too —
  //   - PdfViewer canvas, .analysis-tabs (contract + handover),
  //   - .finding cards on the right (cmp-find is gone).
  await expect(page.locator('.analysis')).toBeVisible({ timeout: 30_000 });
  await expect(
    page.locator('.pdf-viewer canvas[data-pdf-canvas]').first(),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.analysis-tabs')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.finding').first()).toBeVisible({ timeout: 30_000 });
});

test('Litigation portfolio renders KPI row, filters and an empty state on a clean DB', async ({ page }) => {
  // The litigation screen is the new portfolio view (commit on
  // feat/litigation-portfolio): KPI tiles, instance + status segments,
  // search, and a card grid derived from `useMatters()` via selectDisputes.
  // On a wiped e2e DB the seeded test user has zero matters → we should
  // see the empty-state card, not a crashed page.
  await login(page);
  await page.evaluate(() => { localStorage.setItem('lx_route', 'litigation'); });
  await page.reload();

  // Static shell: KPI row + two filter segments + search field. These
  // render regardless of whether any disputes exist.
  await expect(page.locator('.lit-kpi-row')).toBeVisible({ timeout: 15_000 });
  // Four KPI tiles by spec (In progress / Won / Claims total / Hearings ≤ 14d).
  await expect(page.locator('.lit-kpi-row .kpi-tile')).toHaveCount(4);
  // Two filter segments: instance and status.
  await expect(page.locator('.lit-toolbar .seg')).toHaveCount(2);
  // Search input.
  await expect(page.locator('.lit-search input')).toBeVisible();

  // Empty state on a clean DB — useMatters returns [] from /api/matters.
  // The empty card shows lit_empty text and a gavel glyph.
  await expect(page.locator('.mt-empty-lg')).toBeVisible();
});

test('Library shows the persisted contract AND reconciliation as separate rows', async ({ page }) => {
  await login(page);
  // The Library nav item label is the only stable hook; the icon button
  // sits in the sidebar's nav-scroll. Find by accessible name first.
  await page.goto('/');
  // Direct route via localStorage works too; safer to click the sidebar
  // nav item that targets 'library' (the existing route key).
  await page.evaluate(() => { localStorage.setItem('lx_route', 'library'); });
  await page.reload();

  // Library table renders after both useContractRows + useReconciliationRows
  // populate state. Use waitForFunction so we poll the live DOM in one place.
  await page.waitForFunction(
    () => document.querySelectorAll('.lib-table tbody tr').length >= 2,
    null,
    { timeout: 20_000 },
  );
  // Type chips: "Договір" and "Звірка з ПД" come from i18n; assert by chip text.
  // Multiple contracts can be saved across the serial run, so use .first().
  await expect(page.locator('.lib-table .chip', { hasText: /договір/i }).first()).toBeVisible();
  await expect(page.locator('.lib-table .chip', { hasText: /звірка/i }).first()).toBeVisible();
});
