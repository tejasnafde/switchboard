"""Rebuild the Play icon and feature graphic from the Android app resources,
and flatten the screenshots that StoreScreenshotsTest wrote to 24-bit PNG.

Needs Pillow and Playwright:
    python3 -m venv /tmp/pwvenv && /tmp/pwvenv/bin/pip install pillow playwright
    /tmp/pwvenv/bin/python docs/store/play/source/render.py

It drives an installed Chromium: CHROMIUM_PATH when set, else the macOS
Chromium.app when present, else Playwright's own build (install it once with
`/tmp/pwvenv/bin/playwright install chromium`).
"""

import os
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

MAC_CHROMIUM = "/Applications/Chromium.app/Contents/MacOS/Chromium"
HERE = Path(__file__).resolve().parent
PLAY = HERE.parent
RES = HERE.parents[3] / "apps/android/app/src/main/res"


def icon() -> None:
    # The adaptive icon: the foreground composited on @color/switchboard_background.
    fg = Image.open(RES / "drawable-nodpi/switchboard_adaptive_icon.png").convert("RGBA")
    bg = Image.new("RGBA", fg.size, (0x0A, 0x0A, 0x0A, 255))
    bg.alpha_composite(fg)
    bg.resize((512, 512), Image.LANCZOS).save(PLAY / "icon-512.png", optimize=True)


def chromium_path() -> str | None:
    configured = os.environ.get("CHROMIUM_PATH")
    if configured:
        return configured
    return MAC_CHROMIUM if Path(MAC_CHROMIUM).exists() else None


def feature_graphic() -> None:
    out = PLAY / "feature-graphic-1024x500.png"
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=chromium_path())
        page = browser.new_page(viewport={"width": 1024, "height": 500})
        page.goto((HERE / "feature-graphic.html").as_uri(), wait_until="domcontentloaded")
        page.wait_for_selector("img.icon")
        page.evaluate("document.fonts.ready")
        page.wait_for_timeout(500)
        page.locator("#g").screenshot(path=str(out))
        browser.close()
    # Play takes a 24-bit PNG (no alpha) for the feature graphic.
    Image.open(out).convert("RGB").save(out, optimize=True)


def flatten_screenshots() -> None:
    # Robolectric writes RGBA; Play takes screenshots without alpha.
    for shot in sorted(PLAY.glob("0[0-9]-*.png")):
        Image.open(shot).convert("RGB").save(shot, optimize=True)


if __name__ == "__main__":
    icon()
    feature_graphic()
    flatten_screenshots()
