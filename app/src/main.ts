import "./app.css";
import "@xterm/xterm/css/xterm.css";
import App from "./App.svelte";
import { mount } from "svelte";

const app = mount(App, { target: document.getElementById("app")! });
export default app;
