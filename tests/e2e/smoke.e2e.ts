import { expect, test } from "@playwright/test";

// A boot smoke test: the entry route must serve a real, titled, rendered page
// and must not throw while doing it. It deliberately asserts nothing about
// product copy so it stays green across redesigns.
test("the entry route boots and renders", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  const response = await page.goto("/", { waitUntil: "domcontentloaded" });
  expect(response, "no response for /").not.toBeNull();
  expect(response!.status(), `unexpected status for ${response!.url()}`).toBeLessThan(400);

  await expect(page).toHaveTitle(/\S/);

  // Client-rendered apps mount after load, so poll rather than assert once.
  // Text content (not visibility) is the signal: an empty <body> is the
  // white-screen failure this test exists to catch.
  await expect
    .poll(async () => (await page.locator("body").innerText()).trim().length, {
      message: "the app rendered an empty page",
      timeout: 20_000,
    })
    .toBeGreaterThan(0);

  expect(pageErrors, "uncaught errors on load").toEqual([]);
});

test("the entry route serves its own assets", async ({ page }) => {
  const responses: Array<{ status: number; url: string }> = [];
  page.on("response", (response) =>
    responses.push({ status: response.status(), url: response.url() }),
  );

  await page.goto("/", { waitUntil: "load" });

  const origin = new URL(page.url()).origin;
  const failed = responses
    .filter(({ url, status }) => url.startsWith(origin) && status >= 400)
    .map(({ status, url }) => `${status} ${url}`);

  expect(failed, "same-origin requests that failed").toEqual([]);
});
