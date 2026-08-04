import "./app.css";
import Showcase from "./components/Showcase.svelte";
import { mount } from "svelte";
import { initTheme } from "./lib/theme";
import { setupI18n } from "./lib/i18n";

initTheme();   // demo.html 里有同样的内联守卫，这里是首帧之后的权威来源
setupI18n();

const app = mount(Showcase, { target: document.getElementById("app")! });
export default app;
