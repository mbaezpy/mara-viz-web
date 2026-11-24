import { test, expect } from "@playwright/test";

test.describe("Topic Explorer layout modes", () => {
  test("stable vs auto-fit keep finite radii and positions", async ({ page }) => {
    await page.goto("/#/topic_explorer");

    const circles = page.locator("svg#viz circle");
    const slider = page.locator("#since-year-range");
    const toggle = page.locator("#layout-mode-toggle");

    await expect(circles.first()).toBeVisible();
    await expect(slider).toBeVisible();
    await expect(toggle).toBeVisible();

    const assertFiniteCircles = async () => {
      const stats = await circles.evaluateAll((els) =>
        els.map((el) => ({
          r: el.getAttribute("r") || "",
          transform: el.getAttribute("transform") || "",
        }))
      );
      const radii = stats.map((s) => parseFloat(s.r));
      expect(radii.every((v) => Number.isFinite(v))).toBeTruthy();
      expect(stats.every((s) => !s.transform.includes("NaN"))).toBeTruthy();
      expect(radii.some((v) => v > 0)).toBeTruthy();
    };

    const moveSliderTo = async (value: string) => {
      await slider.evaluate((el, v) => {
        (el as HTMLInputElement).value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }, value);
    };

    await assertFiniteCircles();

    const maxVal = (await slider.getAttribute("max")) || "0";
    const minVal = (await slider.getAttribute("min")) || "0";

    // Stable mode: set to earliest year (full data) then latest year snapshot.
    await moveSliderTo(minVal);
    await page.waitForTimeout(300);
    await assertFiniteCircles();

    await moveSliderTo(maxVal);
    await page.waitForTimeout(300);
    await assertFiniteCircles();

    // Switch to auto-fit and move back to min year; layout should remain finite.
    await toggle.click();
    await page.waitForTimeout(200);
    await moveSliderTo(minVal);
    await page.waitForTimeout(500);
    await assertFiniteCircles();
  });
});
