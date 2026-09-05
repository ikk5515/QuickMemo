/* global getComputedStyle */
import { expect } from "@playwright/test";

export async function expectVisibleWikiMotionFinished(page) {
  await expect.poll(() => page.locator(".wiki-panel-stack").evaluate((element) => element.getAnimations({ subtree: true })
    .filter((animation) => animation.playState === "running" && animation.effect?.getTiming().iterations !== Infinity)
    .filter((animation) => {
      const target = animation.effect?.target;
      if (!target || target.closest?.("[inert]")) return false;
      // Firefox retains pending transitions in the unrendered contents of a
      // closed details element. Its client rect and CSS visibility remain set.
      if (typeof target.checkVisibility === "function") return target.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true });
      const closed = target.closest?.("details:not([open])");
      if (closed && closed !== target && !closed.querySelector(":scope > summary")?.contains(target)) return false;
      return target.getClientRects().length > 0 && getComputedStyle(target).visibility === "visible";
    })
    .map((animation) => ({ name: animation.animationName ?? animation.transitionProperty ?? "animation", state: animation.playState,
      target: animation.effect?.target?.className, currentTime: animation.currentTime }))),
  { message: "visible finite Wiki motion finishes" }).toEqual([]);
}
