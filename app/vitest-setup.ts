// Adds jest-dom matchers (toBeInTheDocument, toHaveTextContent, …) to vitest's
// expect, for component tests rendered via @testing-library/svelte.
import "@testing-library/jest-dom/vitest";
// Register the zh/en dictionaries (side effect of importing the i18n module)
// and pin the locale to zh so tests can keep asserting Chinese UI strings
// regardless of jsdom's en-US navigator.language.
import { init } from "svelte-i18n";
import "./src/lib/i18n";

init({ fallbackLocale: "zh", initialLocale: "zh" });
