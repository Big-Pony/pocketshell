import { test, expect, afterEach } from "vitest";
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
