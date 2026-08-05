import { test, expect, afterEach, beforeAll, afterAll, vi } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import { locale } from "svelte-i18n";
import SettingsPanel from "./SettingsPanel.svelte";
import { DEFAULT_SETTINGS, type Settings } from "../lib/settings";

// DeviceManager is only rendered on demand, so a bare object suffices here.
const conn = {} as any;
const base: Settings = { ...DEFAULT_SETTINGS, language: "zh" };
const currentVersion = "0.3.0";
const onCheckUpdate = async () => {};

// vitest-setup pins zh; always restore it so later tests in this file are unaffected.
afterEach(() => locale.set("zh"));

// applyThemeAsync resolves "system" through matchMedia, which jsdom lacks.
let origMatchMedia: typeof window.matchMedia;
beforeAll(() => {
  origMatchMedia = window.matchMedia;
  window.matchMedia = vi.fn().mockReturnValue({
    matches: true, addEventListener() {}, removeEventListener() {},
  }) as unknown as typeof window.matchMedia;
});
afterAll(() => { window.matchMedia = origMatchMedia; });

test("language row offers 中文 / English and reports the choice via onChange", async () => {
  const changes: Settings[] = [];
  const { getByText } = render(SettingsPanel, {
    props: { conn, settings: base, onChange: (s: Settings) => changes.push(s), currentVersion, onCheckUpdate },
  });
  expect(getByText("语言")).toBeInTheDocument();
  await fireEvent.click(getByText("English"));
  expect(changes).toEqual([{ ...base, language: "en" }]);
  await fireEvent.click(getByText("中文"));
  expect(changes[1]).toEqual({ ...base, language: "zh" });
});

test("switching locale re-renders labels without a reload", async () => {
  const { findByText, getByText } = render(SettingsPanel, {
    props: { conn, settings: { ...base, language: "en" }, onChange: () => {}, currentVersion, onCheckUpdate },
  });
  expect(getByText("界面风格")).toBeInTheDocument(); // starts zh (vitest-setup)
  locale.set("en");
  expect(await findByText("Appearance")).toBeInTheDocument();
  expect(await findByText("Language")).toBeInTheDocument();
});

// ── Themes ──
// The list comes from CSS at runtime (theme-tokens.css + the agent's
// /theme/custom.css), and jsdom injects no stylesheets, so `listThemes()`
// falls back to the TS whitelist. That is the behaviour under test here:
// the built-ins must still be pickable when the manifest is unreadable,
// because the alternative is an empty theme menu.

test("theme rows come from listThemes(), so a new .ghostty needs no code here", async () => {
  const { getByText } = render(SettingsPanel, {
    props: { conn, settings: base, onChange: () => {}, currentVersion, onCheckUpdate },
  });
  for (const name of ["奶油深", "奶油浅", "Gruvbox 深", "东京夜", "北欧极夜", "摩卡", "熄屏黑"]) {
    expect(getByText(name), name).toBeInTheDocument();
  }
  expect(getByText("跟随系统")).toBeInTheDocument();
});

test("picking a theme reports it through onChange", async () => {
  const changes: Settings[] = [];
  const { getByText } = render(SettingsPanel, {
    props: { conn, settings: base, onChange: (s: Settings) => changes.push(s), currentVersion, onCheckUpdate },
  });
  await fireEvent.click(getByText("北欧极夜"));
  // applyThemeAsync awaits the stylesheet swap before onChange fires.
  await vi.waitFor(() => expect(changes.at(-1)?.theme).toBe("nord"));
});

test("a custom theme shows its file name, not the slugged id, and deletes by file name", async () => {
  // The whole point of splitting id from display name: `Tokyo Night.ghostty`
  // gets the id `tokyo-night`, and showing that in the menu — or sending it to
  // theme.remove, which keys on the file — would be renaming the user's theme.
  const CSS: Record<string, string> = {
    "--ps-custom-themes": '"tokyo-night"',
    "--ps-name-custom-tokyo-night": '"Tokyo Night"',
    "--ps-scheme-custom-tokyo-night": "dark",
  };
  const origCS = window.getComputedStyle;
  window.getComputedStyle = ((el: Element) => {
    const real = origCS.call(window, el);
    return { getPropertyValue: (p: string) => CSS[p] ?? real.getPropertyValue(p) } as CSSStyleDeclaration;
  }) as typeof window.getComputedStyle;
  const origConfirm = window.confirm;
  window.confirm = () => true;
  try {
    const calls: Array<[string, unknown]> = [];
    const c = { rpc: async (m: string, p: unknown) => { calls.push([m, p]); return { removed: true }; } } as any;
    const { getByText, getByLabelText } = render(SettingsPanel, {
      props: { conn: c, settings: base, onChange: () => {}, currentVersion, onCheckUpdate },
    });
    expect(getByText("Tokyo Night")).toBeInTheDocument();
    await fireEvent.click(getByLabelText("删除主题"));
    await vi.waitFor(() => expect(calls[0]).toEqual(["theme.remove", { name: "Tokyo Night" }]));
  } finally {
    window.getComputedStyle = origCS;
    window.confirm = origConfirm;
  }
});

test("the import form is collapsed until asked for, and sends theme.import", async () => {
  // The main path is `cp` into the agent's themes dir; this is the away-from-
  // your-computer fallback, so it must not take up room by default.
  const calls: Array<[string, unknown]> = [];
  const c = {
    rpc: async (m: string, p: unknown) => {
      calls.push([m, p]);
      return { ok: true, id: "mine", name: "mine", overwritten: false };
    },
  } as any;
  const { getByText, getByPlaceholderText, queryByPlaceholderText } = render(SettingsPanel, {
    props: { conn: c, settings: base, onChange: () => {}, currentVersion, onCheckUpdate },
  });
  expect(queryByPlaceholderText("粘贴 .ghostty 文件内容")).not.toBeInTheDocument();
  await fireEvent.click(getByText("导入主题"));
  await fireEvent.input(getByPlaceholderText("主题名（随便起，空格和点都行）"), { target: { value: "mine" } });
  await fireEvent.input(getByPlaceholderText("粘贴 .ghostty 文件内容"), { target: { value: "background = 000000" } });
  await fireEvent.click(getByText("导入"));
  await vi.waitFor(() => expect(calls[0]).toEqual(["theme.import", { name: "mine", text: "background = 000000" }]));
});

test("a rejected import shows the reason for that reason, not a generic failure", async () => {
  // Four reasons, four messages — "import failed" would leave the user with no
  // idea whether to rename the file, fix its contents or delete another theme.
  const c = { rpc: async () => ({ ok: false, reason: "limit" }) } as any;
  const { getByText, getByPlaceholderText, findByText } = render(SettingsPanel, {
    props: { conn: c, settings: base, onChange: () => {}, currentVersion, onCheckUpdate },
  });
  await fireEvent.click(getByText("导入主题"));
  await fireEvent.input(getByPlaceholderText("主题名（随便起，空格和点都行）"), { target: { value: "mine" } });
  await fireEvent.input(getByPlaceholderText("粘贴 .ghostty 文件内容"), { target: { value: "x" } });
  await fireEvent.click(getByText("导入"));
  expect(await findByText(/上限/)).toBeInTheDocument();
});

test("no connection: importing says so instead of failing silently", async () => {
  const c = { rpc: async () => { throw new Error("offline"); } } as any;
  const { getByText, getByPlaceholderText, findByText } = render(SettingsPanel, {
    props: { conn: c, settings: base, onChange: () => {}, currentVersion, onCheckUpdate },
  });
  await fireEvent.click(getByText("导入主题"));
  await fireEvent.input(getByPlaceholderText("主题名（随便起，空格和点都行）"), { target: { value: "mine" } });
  await fireEvent.input(getByPlaceholderText("粘贴 .ghostty 文件内容"), { target: { value: "x" } });
  await fireEvent.click(getByText("导入"));
  expect(await findByText(/没连上 agent/)).toBeInTheDocument();
});

test("notifications section is collapsed by default and every channel starts off", async () => {
  const { getByText, queryByText } = render(SettingsPanel, {
    props: { conn, settings: base, onChange: () => {}, currentVersion, onCheckUpdate },
  });
  expect(getByText("通知")).toBeInTheDocument();
  // Collapsed: none of the trigger/tool rows are in the DOM yet.
  expect(queryByText("Claude Code")).not.toBeInTheDocument();
  expect(queryByText("添加")).not.toBeInTheDocument();
});

test("expanding the notifications section shows tool toggles and the webhook add button", async () => {
  const { getByText } = render(SettingsPanel, {
    props: { conn, settings: base, onChange: () => {}, currentVersion, onCheckUpdate },
  });
  await fireEvent.click(getByText("通知"));
  expect(getByText("Claude Code")).toBeInTheDocument();
  expect(getByText("Codex")).toBeInTheDocument();
  expect(getByText("opencode")).toBeInTheDocument();
  expect(getByText("Kimi Code")).toBeInTheDocument();
  expect(getByText("Web Push")).toBeInTheDocument();
  expect(getByText("添加")).toBeInTheDocument();
});
