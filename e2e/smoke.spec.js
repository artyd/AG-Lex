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

  // Analysis screen renders the .analysis shell. Loading overlay shows
  // first; wait for the AI panel that appears in 'ready' phase.
  await expect(page.locator('.analysis')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.aipanel-head')).toBeVisible({ timeout: 30_000 });

  // Real findings from the mock: at least one inline <mark.hl> AND at least
  // one FindingCard with a law chip.
  await expect(page.locator('mark.hl').first()).toBeVisible({ timeout: 15_000 });
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

  // Reconciliation result shell. Right-side findings list lives in .cmp-find-list.
  await expect(page.locator('.cmp-find').first()).toBeVisible({ timeout: 30_000 });
});

test('PdfViewer (?pdfview=1) renders a canvas from the uploaded display PDF', async ({ page }) => {
  // Visit with the feature flag *before* login so it survives the SPA's
  // localStorage-based routing. Mock-mode upload serves a stub PDF
  // (e2e/fixtures/mock_display.pdf) so soffice never runs on CI.
  await page.goto('/?pdfview=1');
  await page.locator('.auth-tabs button').nth(1).click();
  await page.locator('input[type="email"]').first().fill('test@aglex.ua');
  const pwd = page.locator('input[type="password"]').first();
  await pwd.fill('test1234');
  await pwd.press('Enter');
  await page.locator('.app').waitFor({ state: 'visible', timeout: 30_000 });
  // Flag should still be in the URL after auth completes.
  await expect(page).toHaveURL(/pdfview=1/);

  await page.locator('.app .sidebar button.btn-primary').first().click();
  const hubContract = page.locator('.hub-block').nth(0);
  await hubContract.click();

  const fileInput = page.locator('input[type="file"][accept*=".docx"]').first();
  await fileInput.setInputFiles(FIXTURES.contract);
  const analyzeBtn = page.locator('.modal .btn-primary').last();
  await expect(analyzeBtn).toBeEnabled({ timeout: 10_000 });
  await analyzeBtn.click();

  // PdfViewer mounts on the analyze route — assert the canvas appears.
  await expect(page.locator('.analysis')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.pdf-viewer')).toBeVisible({ timeout: 30_000 });
  await expect(
    page.locator('.pdf-viewer canvas[data-pdf-canvas]').first(),
  ).toBeVisible({ timeout: 30_000 });
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
