import "./app.css";
import "@xterm/xterm/css/xterm.css";
import App from "./App.svelte";
import { mount } from "svelte";
import { initTheme } from "./lib/theme";
import { setupI18n } from "./lib/i18n";

initTheme(); // apply <html data-theme> before first render (index.html has the same guard inline)
setupI18n(); // init svelte-i18n before mount so no raw keys flash

const app = mount(App, { target: document.getElementById("app")! });
export default app;

// PWA: register the versioned service worker (public/sw.js) in production
// builds only — dev uses vite HMR and must not be intercepted.
//
// The ?v= query is load-bearing: the browser treats a changed registration URL
// as a new worker and runs install/activate, which is how a release swaps cache
// buckets. Same version => identical URL => no-op, which is exactly the
// "no version change, just serve from cache" case.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () =>
    void navigator.serviceWorker.register(`/sw.js?v=${__APP_VERSION__}`),
  );
}
