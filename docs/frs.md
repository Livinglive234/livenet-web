# FRS (Fluid Responsive Scaling) on this site

`public/css/style.css` uses FRS, four locks. One rule on the root font size scales the whole page,
and everything else is measured in `rem`:

```css
html { font-size: calc(100vw / var(--frs-lock) * var(--frs-base)); }
```

| Name | Lock width | Media query | Base size | Columns |
|---|---|---|---|---|
| Mobile | 375 | none (default) | 17 | 1 |
| Tablet | 768 | `min-width: 48em` | 19.5 | 2 |
| Desktop | 1280 | `min-width: 80em` | 21.5 | 3 |
| XL | 2560 | `min-width: 160em` | 22.5 | 4 |

Rules when editing the CSS or adding pages:
- Every length is `rem` (or `em`, `%`, `ch`, `fr`). The only exceptions are `1px` borders and `100vw` in the root rule.
- No `clamp()`, `min()`, `max()`, `vh`, or extra breakpoints. Grids use `repeat(var(--tier-cols), minmax(0, 1fr))`.
- Wide tables and code scroll inside their own box. The page itself never scrolls sideways.
- Colors are variables at the top of the stylesheet, with a light-mode set.

Self-check: paste this in the browser console at widths 374, 375, 767, 768, 1279, 1280, 2559 and 2560.
It should print `rootOK: true` and `sidewaysScroll: false`.

```js
(()=>{const w=innerWidth;const [L,B]=w>=2560?[2560,22.5]:w>=1280?[1280,21.5]:w>=768?[768,19.5]:[375,17];
const want=w/L*B,got=parseFloat(getComputedStyle(document.documentElement).fontSize);
console.log({width:w,lock:L,wantRootPx:+want.toFixed(3),gotRootPx:+got.toFixed(3),rootOK:Math.abs(want-got)<0.01,
sidewaysScroll:document.documentElement.scrollWidth>innerWidth})})()
```
