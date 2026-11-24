import { test, expect } from "@playwright/test";

test.describe("Library interactive search", () => {
  test("supports search filters and chip interactions", async ({ page }) => {
    await page.goto("/#/library");

    const publicationRows = page.locator(".library-table--publications tbody tr");
    await expect(publicationRows.first()).toBeVisible();

    // Add a topic filter from the first available topic tag.
    const topicButton = page.locator('[data-role="topic-tags"] .tag--clickable').first();
    await expect(topicButton).toBeVisible();
    const topicId = (await topicButton.getAttribute("data-topic-id")) || "";
    const topicLabel = (await topicButton.textContent())?.trim() || "";
    expect(topicId).not.toEqual("");
    await topicButton.click();

    const topicChip = page.locator(`.library-filter-chip[data-facet="topics"][data-id="${topicId}"]`);
    await expect(topicChip).toBeVisible();

    const topicRows = page.locator(".library-table--publications tbody tr");
    const topicRowCount = await topicRows.count();
    expect(topicRowCount).toBeGreaterThan(0);
    for (let i = 0; i < topicRowCount; i += 1) {
      // A parent filter includes papers tagged with a child topic; the row
      // displays that more specific tag rather than repeating the parent.
      await expect(topicRows.nth(i).locator(
        `[data-topic-id="${topicId}"], [data-topic-id^="${topicId}."]`
      ).first()).toBeVisible();
    }

    await topicChip.locator('[data-role="remove-filter"]').click();
    await expect(topicChip).toHaveCount(0);

    // Add an author filter from the first local author button.
    const authorButton = page.locator(".library-author-link").first();
    await expect(authorButton).toBeVisible();
    const authorId = (await authorButton.getAttribute("data-author-id")) || "";
    const authorLabel = (await authorButton.textContent())?.trim() || "";
    expect(authorId).not.toEqual("");
    await authorButton.click();

    const authorChip = page.locator(`.library-filter-chip[data-facet="authors"][data-id="${authorId}"]`);
    await expect(authorChip).toBeVisible();

    const authorRows = page.locator(".library-table--publications tbody tr");
    const authorRowCount = await authorRows.count();
    expect(authorRowCount).toBeGreaterThan(0);
    for (let i = 0; i < authorRowCount; i += 1) {
      await expect(authorRows.nth(i).locator(`[data-author-id="${authorId}"]`).first()).toBeVisible();
    }

    // Add a journal filter from the first venue button.
    const venueButton = authorRows.nth(0).locator(".library-venue button").first();
    await expect(venueButton).toBeVisible();
    const venueId = (await venueButton.getAttribute("data-journal-id")) || "";
    expect(venueId).not.toEqual("");
    await venueButton.click();

    const journalChip = page.locator(`.library-filter-chip[data-facet="journals"][data-id="${venueId}"]`);
    await expect(journalChip).toBeVisible();

    const journalRows = page.locator(".library-table--publications tbody tr");
    const journalRowCount = await journalRows.count();
    expect(journalRowCount).toBeGreaterThan(0);
    for (let i = 0; i < journalRowCount; i += 1) {
      await expect(
        journalRows.nth(i).locator(`.library-venue[data-journal-id="${venueId}"]`).first()
      ).toBeVisible();
    }

    // Clear all filters and ensure chips disappear.
    await page.locator(".library-filter-clear").click();
    await expect(page.locator(".library-filter-chip")).toHaveCount(0);
    // Clearing filters preserves the user's sorting preference in the route.
    await expect(page).toHaveURL(/#\/library(?:\?sort=[^&]+)?$/);

    // Exercise free-text search and clear.
    const searchInput = page.locator('[data-role="search"]');
    await searchInput.fill("cortex");
    await page.waitForTimeout(400);
    await expect(page.locator(".library-title mark").first()).toBeVisible();
    await expect(page.locator('[data-role="search-clear"]')).toBeVisible();
    await page.locator('[data-role="search-clear"]').click();
    await expect(searchInput).toHaveValue("");
    await expect(page.locator(".library-title mark")).toHaveCount(0);

    // Toggle between Authors and Publications tabs.
    const authorsTab = page.locator('[data-role="mode-btn"][data-mode="authors"]');
    const publicationsTab = page.locator('[data-role="mode-btn"][data-mode="publications"]');
    await authorsTab.click();
    await expect(page.locator(".library-table--authors")).toBeVisible();
    await publicationsTab.click();
    await expect(page.locator(".library-table--publications")).toBeVisible();
    await expect(authorsTab).not.toHaveClass(/is-active/);
    await expect(publicationsTab).toHaveClass(/is-active/);
  });
});
