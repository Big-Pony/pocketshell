// jest-dom matcher types for vitest's `expect` (toBeInTheDocument, …).
// The runtime registration lives in vitest-setup.ts (`import
// "@testing-library/jest-dom/vitest"`); this side-effect import is the shape
// the package documents for making tsc see the augmented `Assertion` interface.
import "@testing-library/jest-dom/vitest";
