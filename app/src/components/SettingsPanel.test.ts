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

// ── 键盘键位（kbLayout）──
// 与「键盘布局」（settings.layout，Mac/Win 键帽标注）是两回事，两者的中文标签
// 只差一个字，断言时要盯住「键盘键位」这四个字。

test("键位选择器在设置面板最上面（排在主题之前）", () => {
  const { container } = render(SettingsPanel, {
    props: { conn, settings: base, onChange: vi.fn(), currentVersion, onCheckUpdate },
  });
  const first = container.querySelector(".stg > .set");
  expect(first?.textContent).toContain("键盘键位");
});

test("三套键位都列出来，各带一句说明", () => {
  const { container } = render(SettingsPanel, {
    props: { conn, settings: base, onChange: vi.fn(), currentVersion, onCheckUpdate },
  });
  const box = container.querySelector('[aria-label="键盘键位"]') as HTMLElement;
  expect(box.textContent).toContain("经典");
  expect(box.textContent).toContain("分层");
  expect(box.textContent).toContain("上滑");
  expect(box.textContent).toContain("数字符号在第二层");
});

test("当前键位是选中态", () => {
  const { container } = render(SettingsPanel, {
    props: { conn, settings: { ...base, kbLayout: "flick" }, onChange: vi.fn(), currentVersion, onCheckUpdate },
  });
  const checked = container.querySelector('[aria-label="键盘键位"] [aria-checked="true"]');
  expect(checked?.textContent).toContain("上滑");
});

test("点另一套键位会 onChange 出去", async () => {
  const onChange = vi.fn();
  const { container } = render(SettingsPanel, {
    props: { conn, settings: base, onChange, currentVersion, onCheckUpdate },
  });
  const btns = [...container.querySelectorAll('[aria-label="键盘键位"] [role="radio"]')];
  const layered = btns.find((b) => b.textContent?.includes("分层")) as HTMLElement;
  await fireEvent.click(layered);
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ kbLayout: "layered" }));
});

test("有「重看键盘教程」入口，点完给出已重置反馈", async () => {
  const { container } = render(SettingsPanel, {
    props: { conn, settings: base, onChange: vi.fn(), currentVersion, onCheckUpdate },
  });
  expect(container.textContent).toContain("重看键盘教程");
  const btn = [...container.querySelectorAll("button")]
    .find((b) => b.textContent?.trim() === "重看") as HTMLButtonElement;
  expect(btn).toBeTruthy();
  await fireEvent.click(btn);
  // 这个动作没有立即可见的效果（教程要下次切布局才弹），必须给反馈，
  // 否则用户以为没点上会反复点。
  expect(btn.textContent?.trim()).toBe("已重置");
  expect(btn.disabled).toBe(true);
});

test("重看会清掉两套教程的看过标记", async () => {
  localStorage.setItem("ps.kbTutSeen.layered", "1");
  localStorage.setItem("ps.kbTutSeen.flick", "1");
  const { container } = render(SettingsPanel, {
    props: { conn, settings: base, onChange: vi.fn(), currentVersion, onCheckUpdate },
  });
  const btn = [...container.querySelectorAll("button")]
    .find((b) => b.textContent?.trim() === "重看") as HTMLButtonElement;
  await fireEvent.click(btn);
  expect(localStorage.getItem("ps.kbTutSeen.layered")).toBeNull();
  expect(localStorage.getItem("ps.kbTutSeen.flick")).toBeNull();
});

// ── 14 期需求 5：通知开关 pending 态 ──
// 全项目最容易诱发重复点击的位置：点下去 UI 完全不动（cfg 仅在成功后更新），
// 而 notify.wire 要在 agent 侧读写 CC 的配置文件，重复点会真的重复执行。
test("通知工具开关点击后立即禁用，避免重复触发 notify.wire", async () => {
  let releaseWire: ((v: unknown) => void) | null = null;
  const wireConn = {
    notifyGetConfig: async () => ({}),
    notifyWire: vi.fn(() => new Promise((r) => { releaseWire = r; })),
    notifyUnwire: vi.fn(async () => ({ ok: true })),
    notifySetConfig: vi.fn(async () => {}),
  } as any;
  const { getByText, getAllByText } = render(SettingsPanel, {
    props: { conn: wireConn, settings: base, onChange: () => {}, currentVersion, onCheckUpdate },
  });
  await fireEvent.click(getByText("通知"));           // 展开通知分区
  const onBtns = await vi.waitFor(() => {
    const b = getAllByText("开") as HTMLButtonElement[];
    expect(b.length).toBeGreaterThan(0);
    return b;
  });
  const first = onBtns[0] as HTMLButtonElement;
  await fireEvent.click(first);
  await vi.waitFor(() => expect(first.disabled).toBe(true));
  releaseWire!({ ok: true });
  await vi.waitFor(() => expect(first.disabled).toBe(false));
  // 二次点击在 pending 期间被忽略：只发出过一次 wire
  expect(wireConn.notifyWire).toHaveBeenCalledTimes(1);
});

test("webhook 测试期间按钮变「测试中…」并禁用", async () => {
  let release: ((v: unknown) => void) | null = null;
  const wh = { id: "w1", name: "群机器人", kind: "wecom", url: "https://x", enabled: true };
  const whConn = {
    notifyGetConfig: async () => ({ webhooks: [wh] }),
    notifyTestWebhook: vi.fn(() => new Promise((r) => { release = r; })),
    notifySetConfig: vi.fn(async () => {}),
  } as any;
  const { getByText, findByText } = render(SettingsPanel, {
    props: { conn: whConn, settings: base, onChange: () => {}, currentVersion, onCheckUpdate },
  });
  await fireEvent.click(getByText("通知"));
  const btn = (await findByText("测试发送")) as HTMLButtonElement;
  await fireEvent.click(btn);
  expect(await findByText("测试中…")).toBeTruthy();
  expect(btn.disabled).toBe(true);
  release!({ ok: true });
  await findByText("测试发送");
});

// ---------------------------------------------------------------------------
// 测试推送（14 期需求 4）
//
// 成功的定义是**端到端送达**，不是 HTTP 201：生产取证正是"FCM 返回 201 但
// 设备无声"。这几条钉住"201 且无回报时必须报失败"——没有它，按钮会在真正
// 失效的情况下报成功，比没有按钮更糟。
// ---------------------------------------------------------------------------

function pushConn(testPush: () => Promise<{ ok: boolean; error?: string }>) {
  return {
    notifyGetConfig: async () => ({ webPush: true }),
    notifySetConfig: vi.fn(async () => {}),
    notifyTestPush: testPush,
  } as any;
}

/** 模拟 sw.js 的回报：向页面派发一条 SW message。 */
function fireDiagReceived() {
  const sw = navigator.serviceWorker as unknown as EventTarget | undefined;
  const ev = new MessageEvent("message", { data: { type: "push-diag-received" } });
  sw?.dispatchEvent(ev);
}

let swListeners: Array<(e: MessageEvent) => void> = [];
beforeAll(() => {
  if (!("serviceWorker" in navigator)) {
    // jsdom 没有 serviceWorker；装一个只支持 add/removeEventListener 的替身。
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        addEventListener: (_t: string, f: (e: MessageEvent) => void) => { swListeners.push(f); },
        removeEventListener: (_t: string, f: (e: MessageEvent) => void) => { swListeners = swListeners.filter((x) => x !== f); },
        dispatchEvent: (e: MessageEvent) => { for (const f of [...swListeners]) f(e); return true; },
      },
    });
  }
});

test("测试推送：SW 回报送达时显示成功", async () => {
  const { getByText, findByText } = render(SettingsPanel, {
    props: { conn: pushConn(async () => ({ ok: true })), settings: base, onChange: () => {}, currentVersion, onCheckUpdate },
  });
  await fireEvent.click(getByText("通知"));
  await fireEvent.click(await findByText("测试推送"));
  fireDiagReceived();
  expect(await findByText("✓ 推送已送达本机")).toBeTruthy();
});

test("测试推送：推送服务受理了但本机没收到 → 判失败（201 不等于送达）", async () => {
  vi.useFakeTimers();
  try {
    const { getByText, findByText } = render(SettingsPanel, {
      props: { conn: pushConn(async () => ({ ok: true })), settings: base, onChange: () => {}, currentVersion, onCheckUpdate },
    });
    await fireEvent.click(getByText("通知"));
    await fireEvent.click(await findByText("测试推送"));
    await vi.advanceTimersByTimeAsync(11000); // 越过等待窗口，全程不回报
    expect(getByText(/本机未收到/)).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});

test("测试推送：发送本身失败时带出原因，不等待", async () => {
  const { getByText, findByText } = render(SettingsPanel, {
    props: {
      conn: pushConn(async () => ({ ok: false, error: "no_subscription" })),
      settings: base, onChange: () => {}, currentVersion, onCheckUpdate,
    },
  });
  await fireEvent.click(getByText("通知"));
  await fireEvent.click(await findByText("测试推送"));
  expect(await findByText(/no_subscription/)).toBeTruthy();
});

test("推送关着时不显示测试按钮（点了必然失败，摆出来只会误导）", async () => {
  const offConn = {
    notifyGetConfig: async () => ({ webPush: false }),
    notifySetConfig: vi.fn(async () => {}),
  } as any;
  const { getByText, queryByText, findByText } = render(SettingsPanel, {
    props: { conn: offConn, settings: base, onChange: () => {}, currentVersion, onCheckUpdate },
  });
  await fireEvent.click(getByText("通知"));
  await findByText("Web Push");
  expect(queryByText("测试推送")).toBeNull();
});
