// Shared test helpers. The demo user (`test@aglex.ua` / `test1234`) is
// seeded on every backend boot via auth.seed_test_user, so no extra
// fixture-side registration is needed.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEMO_EMAIL = 'test@aglex.ua';
export const DEMO_PASSWORD = 'test1234';

export const FIXTURES = {
  contract: path.join(__dirname, 'fixtures', 'contract.docx'),
  contractPair: path.join(__dirname, 'fixtures', 'contract-pair.docx'),
  handover: path.join(__dirname, 'fixtures', 'handover.xlsx'),
};

/** Log in via the visible Auth screen. Lands on the dashboard. */
export async function login(page) {
  await page.goto('/');
  // Auth defaults to the sign-up tab; the second tab is sign-in.
  await page.locator('.auth-tabs button').nth(1).click();
  await page.locator('input[type="email"]').first().fill(DEMO_EMAIL);
  const pwd = page.locator('input[type="password"]').first();
  await pwd.fill(DEMO_PASSWORD);
  await pwd.press('Enter');
  // The sidebar appears only when authenticated — anchor the wait on it.
  await page.locator('.app').waitFor({ state: 'visible', timeout: 30_000 });
}

