# Mockup rendering

Map the proposed UI changes to the screens and states a reviewer needs to evaluate. Use the target project's visual conventions, locale, and existing mockup sources. When multiple distinct surfaces materially change, provide one HTML and JPEG pair per surface. Show the relevant success, empty, error, permission, or responsive states when they affect the decision. Include interaction details in the plan if a static image cannot convey them.

Use existing mockup paths or default to `docs/mockups/`. Create standalone HTML with synthetic data and local or embedded assets. Use an existing browser renderer or run the bundled renderer from the target checkout with a locally available Playwright package and Chromium:

```bash
node /absolute/path/to/plan-pr/scripts/render-mockup.cjs docs/mockups/issue-42-export.html
```

Pass `WIDTH HEIGHT` after the input to override the default 1440×1000 viewport. The renderer replaces `.html` with `.jpeg` and captures the full page. It blocks HTTP, HTTPS, and WebSocket connections while preserving local and embedded assets. Use a viewport that shows the review-critical state.

The renderer requires Playwright 1.48 or later. If the target checkout lacks it, set `PLAN_PR_PLAYWRIGHT_ROOT` to a separate directory containing `node_modules/playwright`. Use an existing tooling directory or, when tooling installation is allowed, install into a temporary directory with `npm install --prefix "$renderer_dir" --no-save playwright`. If Playwright's matching Chromium is missing, install it with `node "$renderer_dir/node_modules/playwright/cli.js" install chromium`, using the directory containing the selected Playwright package. To use installed Google Chrome, set `PLAN_PR_CHROMIUM_CHANNEL=chrome`. Otherwise use an available browser screenshot tool that can produce a JPEG. Keep renderer tooling out of the PR.

Inspect the generated JPEG for missing assets, incorrect state, or clipping, and link both files from the plan. If rendering remains blocked, report the gap and keep the proposal local when the missing image is essential to review.

For mockups-only requests, update the supplied plan's mockup links or report the paths when it cannot be edited. If the plan does not establish the visual change, resolve the missing design decision before rendering.
