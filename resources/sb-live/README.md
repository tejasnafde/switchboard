# Bundled libraries for inline live pages

Served at `/_sb/<path>` only to ```html-live frames and to a live page opened
in the HTML preview pane (`src/main/preview/`). Nothing else loads in those
frames. The files are vendored unmodified from the npm packages below, so a
change here is a version bump: replace the file, update this table and the
checksums in `tests/unit/html-live-libraries.test.ts`.

| Path | Package | File in the package | Licence |
|---|---|---|---|
| `chart.js` | chart.js 4.5.1 | `dist/chart.umd.min.js` | MIT, `licenses/chart.js-LICENSE.md` |
| `d3.js` | d3 7.9.0 | `dist/d3.min.js` | ISC, `licenses/d3-LICENSE` |
| `three.js` | three 0.170.0 | `build/three.module.min.js` (an ES module) | MIT, `licenses/three-LICENSE` |
| `three/addons/controls/OrbitControls.js` | three 0.170.0 | `examples/jsm/controls/OrbitControls.js` | MIT, `licenses/three-LICENSE` |

`/_sb/mermaid.js` is not here: it is `mermaid/dist/mermaid.min.js` from the
app's own `mermaid` dependency (MIT), the copy the chat diagrams already use.

Pages load Three.js as a module through the import map the frame injects:
`import * as THREE from 'three'` and
`import { OrbitControls } from 'three/addons/controls/OrbitControls.js'`.
