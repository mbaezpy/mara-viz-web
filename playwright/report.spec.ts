import { test, expect } from "@playwright/test";

test("citation reports show snapshot coverage and render cumulative charts without errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const years = [
    { year: 2018, pubs: 1, citations: 12, cum_citations: 12 },
    { year: 2026, pubs: 1, citations: 5, cum_citations: 17 },
  ];
  await page.route("**/data/reports.json", route => route.fulfill({
    json: {
      citation_stats: { papers: 2, refreshed_papers: 2, oldest_refresh: "2026-11-24T12:00:00+00:00" },
      publications: { years, venues: [], total_citations: 17 },
      topics: { years: [2018, 2026], topics: [{ topic_id: "A", topic: "Topic A", pubs_total: 2, cites_total: 17, series: years }] },
    },
  }));
  await page.goto("/#/report?section=publications&report=cites_per_year");
  await expect(page.locator('[data-role="report-title"]')).toHaveText("Citations by publication year");
  await expect(page.locator('[data-role="report-meta"]')).toContainText("Refreshed 2 of 2 papers");

  const select = page.locator('[data-role="report-select"]');
  const show = page.locator('[data-role="report-show"]');
  await select.selectOption("publications:cum_cites_per_year");
  await show.click();
  await expect(page.locator('[data-role="report-meta"]')).toContainText("Total citations: 17");
  await expect(page.locator('[data-role="report-chart"] svg')).toBeVisible();

  await select.selectOption("topics:topic_cum_cites_over_time");
  await show.click();
  await expect(page.locator('[data-role="report-meta"]')).toContainText("Topic totals can overlap.");
  await expect(page.getByLabel("Normalize to first year")).toBeVisible();
  await page.getByLabel("Normalize to first year").check();
  await expect(page.locator('[data-role="report-chart"] svg')).toBeVisible();
  expect(errors).toEqual([]);
});
