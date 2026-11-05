import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `tsc` compiles the test files into `dist/` as well — without this the
    // suite runs twice (once from `extensions/`, once from the compiled
    // copies), which doubles the runtime and can fail on stale output.
    exclude: [...configDefaults.exclude, "dist/**"],
  },
});
