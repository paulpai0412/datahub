import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

for (const embedded of [false, true]) {
  test(`theme boot respects deployment without rewriting saved preference: embedded=${embedded}`, () => {
    const url = new URL("../lib/theme.ts", import.meta.url).href;
    const result = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import vm from 'node:vm';
      const { DATAHUB_EMBED, THEME_INIT_SCRIPT } = await import(${JSON.stringify(url)});
      let dark = false, reads = 0;
      const root = { dataset: {}, classList: { remove() { dark = false; }, toggle(_name, value) { dark = value; } } };
      vm.runInNewContext(THEME_INIT_SCRIPT, {
        document: { documentElement: root },
        localStorage: { getItem() { reads++; return 'pine'; }, setItem() { throw new Error('must not persist'); } },
        window: { matchMedia() { return { matches: true }; } }
      });
      console.log(JSON.stringify({ embedded: DATAHUB_EMBED, theme: root.dataset.theme, dark, reads }));
    `,
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          NEXT_PUBLIC_DATAHUB_EMBED: String(embedded),
        },
        encoding: "utf8",
      },
    );
    assert.deepEqual(JSON.parse(result), {
      embedded,
      theme: embedded ? "light" : "pine",
      dark: !embedded,
      reads: embedded ? 0 : 1,
    });
  });
}
