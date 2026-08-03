// PocketShell 官网脚本 —— 中英两版共用。
// 文案不写在这里：轮播说明从每张 img 的 data-cap 读，复制按钮从 data-copy 读，
// 这样加语言版本只改 HTML，不动这个文件。
(() => {
  const root = document.getElementById("car");
  if (!root) return;
  const slides = [...root.querySelectorAll(".car-track img")];
  const cap = document.getElementById("car-cap");
  const dots = document.getElementById("car-dots");
  const dotLabel = dots.dataset.label || "Slide %n";
  let i = 0, timer = null;

  slides.forEach((_, n) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-label", dotLabel.replace("%n", String(n + 1)));
    b.addEventListener("click", () => { show(n); restart(); });  // 点选后重新计时，不抢走这一张
    dots.appendChild(b);
  });

  function show(n) {
    i = n;
    slides.forEach((s, k) => s.classList.toggle("on", k === n));
    [...dots.children].forEach((d, k) => d.setAttribute("aria-current", String(k === n)));
    cap.innerHTML = slides[n].dataset.cap || "";
  }
  const next = () => show((i + 1) % slides.length);
  function restart() {
    clearInterval(timer);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    timer = setInterval(next, 3600);
  }
  // 不做悬停暂停：鼠标常年停在图上，会让它看起来根本不动
  // 滑出视口就停，省电
  new IntersectionObserver(es => es.forEach(e => e.isIntersecting ? restart() : clearInterval(timer)),
    { threshold: .2 }).observe(root);

  show(0);
})();

document.querySelectorAll("[data-copy]").forEach(btn => {
  const done = btn.dataset.copied || "copied ✓";
  const idle = btn.textContent;
  btn.addEventListener("click", () => {
    navigator.clipboard.writeText(btn.dataset.copy);
    btn.textContent = done;
    setTimeout(() => (btn.textContent = idle), 1600);
  });
});
