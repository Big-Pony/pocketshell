import "./app.css";
import "@xterm/xterm/css/xterm.css";
import App from "./App.svelte";
import { mount } from "svelte";
import { initTheme } from "./lib/theme";

initTheme(); // apply <html data-theme> before first render (index.html has the same guard inline)

const app = mount(App, { target: document.getElementById("app")! });
export default app;
