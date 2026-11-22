import { expect, type Page } from '@playwright/test';

export interface MobileViewportSpec {
  name: string;
  width: number;
  height: number;
}

export const MOBILE_VIEWPORTS: MobileViewportSpec[] = [
  { name: 'android-360', width: 360, height: 800 },
  { name: 'iphone-390', width: 390, height: 844 },
  { name: 'pixel-412', width: 412, height: 915 }
];

export const COLOR_SCHEMES: Array<'light' | 'dark'> = ['light', 'dark'];

export interface LayoutAuditOptions {
  checkSortChip?: boolean;
  colorScheme?: 'light' | 'dark';
  checkSelectionOverlap?: boolean;
}

export async function assertMobileLayoutHealthy(page: Page, opts: LayoutAuditOptions = {}): Promise<void> {
  const report = await page.evaluate((options) => {
    const issues: string[] = [];
    const innerWidth = window.innerWidth;
    const docEl = document.documentElement;

    if (docEl.scrollWidth > docEl.clientWidth) {
      issues.push(`Document horizontal overflow: scrollWidth=${docEl.scrollWidth} > clientWidth=${docEl.clientWidth}`);
    }

    const isActuallyVisible = (el: HTMLElement): boolean => {
      let cur: HTMLElement | null = el;
      while (cur && cur !== document.documentElement) {
        const cs = window.getComputedStyle(cur);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') {
          return false;
        }
        if (cur.getAttribute('aria-hidden') === 'true') {
          return false;
        }
        cur = cur.parentElement;
      }
      return true;
    };

    // Check every visible interactive element fits within [0, innerWidth]
    const controls = Array.from(
      document.querySelectorAll<HTMLElement>('button, a, input, select, [role="tab"]')
    );
    for (const el of controls) {
      if (!isActuallyVisible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      if (rect.left < -1 || rect.right > innerWidth + 1) {
        const label =
          el.getAttribute('aria-label') ||
          el.textContent?.trim().slice(0, 40) ||
          el.tagName;
        issues.push(
          `Control "${label}" clipped/outside viewport [0, ${innerWidth}]: left=${Math.round(rect.left)}, right=${Math.round(rect.right)}`
        );
      }
    }

    // Check .table-wrap containers do not hide horizontal overflow on mobile
    const tableWraps = Array.from(document.querySelectorAll<HTMLElement>('.table-wrap'));
    for (const wrap of tableWraps) {
      if (!isActuallyVisible(wrap)) continue;
      const wRect = wrap.getBoundingClientRect();
      if (wRect.width === 0 || wRect.height === 0) continue;
      if (wrap.scrollWidth > wrap.clientWidth + 1) {
        issues.push(
          `.table-wrap horizontal overflow: scrollWidth=${wrap.scrollWidth} > clientWidth=${wrap.clientWidth}`
        );
      }
    }

    // Explicitly check .chip-strip and "Ngày chụp" sort control when requested
    if (options.checkSortChip) {
      const strip = document.querySelector<HTMLElement>('.chip-strip');
      if (!strip) {
        issues.push('Missing .chip-strip on Library screen');
      } else {
        if (strip.scrollWidth > strip.clientWidth + 1) {
          issues.push(
            `.chip-strip horizontal overflow: scrollWidth=${strip.scrollWidth} > clientWidth=${strip.clientWidth}`
          );
        }
        const sortEl =
          strip.querySelector<HTMLElement>('select[aria-label="Sắp xếp"]') ??
          Array.from(strip.querySelectorAll<HTMLElement>('button, select')).find((c) =>
            (c.textContent ?? '').includes('Ngày chụp')
          ) ??
          null;
        if (!sortEl) {
          issues.push('Missing "Ngày chụp" sort control inside .chip-strip');
        } else {
          const sRect = sortEl.getBoundingClientRect();
          if (sRect.width < 60 || sRect.height < 20) {
            issues.push(`"Ngày chụp" sort control collapsed: ${sRect.width}x${sRect.height}`);
          }
          if (sRect.left < 0 || sRect.right > innerWidth - 1) {
            issues.push(
              `"Ngày chụp" sort control clipped at right edge (innerWidth=${innerWidth}): left=${Math.round(sRect.left)}, right=${Math.round(sRect.right)}`
            );
          }
          // Check text truncation inside strip for both <select> and <button>
          if (sortEl.tagName === 'BUTTON' && sortEl.scrollWidth > sortEl.clientWidth + 2) {
            issues.push(
              `"Ngày chụp" button text clipped internally: scrollWidth=${sortEl.scrollWidth} > clientWidth=${sortEl.clientWidth}`
            );
          } else if (sortEl.tagName === 'SELECT') {
            const selectEl = sortEl as HTMLSelectElement;
            if (selectEl.scrollWidth > selectEl.clientWidth + 1) {
              issues.push(
                `"Ngày chụp" <select> horizontal overflow: scrollWidth=${selectEl.scrollWidth} > clientWidth=${selectEl.clientWidth}`
              );
            }
            const activeText =
              selectEl.selectedOptions?.[0]?.textContent?.trim() || 'Ngày chụp';
            const sortStyle = window.getComputedStyle(selectEl);
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.font =
                sortStyle.font && sortStyle.font.trim().length > 0
                  ? sortStyle.font
                  : `${sortStyle.fontWeight} ${sortStyle.fontSize} ${sortStyle.fontFamily}`;
              const textWidth = ctx.measureText(activeText).width;
              const padLeft = parseFloat(sortStyle.paddingLeft) || 0;
              const padRight = parseFloat(sortStyle.paddingRight) || 0;
              const minNeeded = textWidth + padLeft + padRight + 14;
              if (selectEl.clientWidth < minNeeded) {
                issues.push(
                  `"Ngày chụp" <select> truncates "${activeText}": clientWidth=${selectEl.clientWidth} < needed=${Math.ceil(minNeeded)} (text=${Math.ceil(textWidth)})`
                );
              }
            }
          }
        }
      }
    }

    // Selection bar vs floating bottom nav overlap check
    const selBar = document.querySelector<HTMLElement>('.selection-bar');
    const navBar = document.querySelector<HTMLElement>('nav.nav');
    if (selBar && navBar) {
      const selStyle = window.getComputedStyle(selBar);
      const navStyle = window.getComputedStyle(navBar);
      if (selStyle.display !== 'none' && navStyle.display !== 'none') {
        const sRect = selBar.getBoundingClientRect();
        const nRect = navBar.getBoundingClientRect();
        if (sRect.height > 0 && nRect.height > 0 && sRect.bottom > nRect.top + 1) {
          issues.push(
            `.selection-bar (bottom=${Math.round(sRect.bottom)}) overlaps nav.nav (top=${Math.round(nRect.top)})`
          );
        }
      }
    } else if (options.checkSelectionOverlap) {
      issues.push('Expected both .selection-bar and nav.nav to be visible for overlap check');
    }

    // Color scheme luminance & contrast check
    if (options.colorScheme) {
      const surface =
        document.querySelector<HTMLElement>('.auth-layout, .app, main') ?? document.body;
      const parseRgb = (cssColor: string): [number, number, number] | null => {
        const m = cssColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
        if (!m) return null;
        return [Number(m[1]), Number(m[2]), Number(m[3])];
      };
      const bgCss = window.getComputedStyle(document.body).backgroundColor;
      const surfaceBgCss = window.getComputedStyle(surface).backgroundColor;
      const fgCss = window.getComputedStyle(surface).color;

      const bgRgb = parseRgb(bgCss) ?? parseRgb(surfaceBgCss);
      const fgRgb = parseRgb(fgCss);

      if (bgRgb) {
        const lum = 0.2126 * bgRgb[0] + 0.7152 * bgRgb[1] + 0.0722 * bgRgb[2];
        if (options.colorScheme === 'light' && lum < 180) {
          issues.push(`Expected light background luminance >= 180, got ${lum.toFixed(1)} (${bgCss})`);
        }
        if (options.colorScheme === 'dark' && lum > 70) {
          issues.push(`Expected dark background luminance <= 70, got ${lum.toFixed(1)} (${bgCss})`);
        }
        if (fgRgb) {
          const fgLum = 0.2126 * fgRgb[0] + 0.7152 * fgRgb[1] + 0.0722 * fgRgb[2];
          if (Math.abs(fgLum - lum) < 80) {
            issues.push(`Insufficient foreground/background contrast: bg=${bgCss}, fg=${fgCss}`);
          }
        }
      }
    }

    return issues;
  }, opts);

  expect(report, `Mobile layout audit failed:\n${report.join('\n')}`).toEqual([]);
}
