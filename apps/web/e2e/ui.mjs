/**
 * Reveal a control that may live behind a collapsed panel.
 *
 * The editor moved from one long scrolling sidebar to a rail of grouped
 * panels, so most controls are no longer in the DOM until their panel is
 * open. The suites could have been kept working with a test-only "expand
 * everything" flag, but then they would be exercising a layout no user ever
 * sees — and the thing most likely to break in a restructure is precisely
 * whether a control is still reachable.
 *
 * So this opens panels until the control appears, which means every suite
 * also asserts, incidentally, that the control is still reachable at all.
 */

/**
 * Locator for `testid`, with its owning panel opened if needed.
 *
 * The stop condition is PRESENCE, not visibility. A closed panel isn't
 * rendered at all, so `count() > 0` already means "its panel is open" — and
 * some controls are attached but deliberately never visible, the hidden file
 * inputs behind every drop zone being the obvious case. Waiting for
 * visibility would cycle past the right panel and land on the wrong one.
 */
export async function reveal(page, testid) {
  const target = page.locator(`[data-testid="${testid}"]`).first();
  if (await present(target)) return target;

  const tabs = await page.locator('[data-testid^="tab-"]').all();
  for (const tab of tabs) {
    // tab-badge-* share the prefix; only real tabs toggle a panel.
    const id = await tab.getAttribute('data-testid');
    if (!id || id.startsWith('tab-badge-')) continue;
    await tab.click().catch(() => {});
    await page.waitForTimeout(120);
    if (await present(target)) return target;
  }
  // Return it anyway so the caller's own assertion produces the error message,
  // rather than this helper throwing something less informative.
  return target;
}

async function present(locator) {
  try {
    return (await locator.count()) > 0;
  } catch {
    return false;
  }
}

/** Open a named panel directly, when the test knows where it is going. */
export async function openPanel(page, id) {
  const tab = page.locator(`[data-testid="tab-${id}"]`);
  if ((await tab.count()) === 0) return false;
  if ((await tab.getAttribute('data-on')) !== '1') {
    await tab.click();
    await page.waitForTimeout(150);
  }
  return true;
}

/** Set a range input by value, firing the events React listens for. */
export async function setRange(page, testid, value) {
  await reveal(page, testid);
  await page.evaluate(
    ({ id, v }) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (!el) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, String(v));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { id: testid, v: value },
  );
  await page.waitForTimeout(600);
}

/** Click a control, opening its panel first if necessary. */
export async function click(page, testid) {
  const el = await reveal(page, testid);
  await el.click();
}

/** Does this control exist anywhere in the UI, in any panel? */
export async function exists(page, testid) {
  const el = await reveal(page, testid);
  return (await el.count()) > 0;
}
