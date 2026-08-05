// app/scripts/build-fonts.ts
// 从上游的 Nerd Font 预打补丁版产出终端用的 woff2 子集。
// 用法：cd app && bun run gen:fonts
//
// 为什么不直接用上游原版：Fontsource 等渠道分发的 latin 子集**没有终端字形**
// （实测 Monaspace/UbuntuMono/GoogleSansCode 的制表符、块、Powerline 全是 0），
// 终端里 tmux 框线会逐字符掉回系统字体、接缝错位。Nerd Fonts 官方已经打好补丁，
// 但每个 TTF 约 2.4MB——5 套进二进制是 12MB × 4 平台，不现实。所以在这里切一刀：
// 只保留终端真正用到的范围，22–49KB/套。
//
// **产物提交进仓库**（与 src/theme-tokens.css 同模式）：日常开发与 CI 都不需要
// Python，只有加/换字体时才跑本脚本。
//
// 上游 URL **钉死 tag**，不用 latest：上游发新版时字形与内部命名都可能变，
// 钉死才能保证重跑本脚本产出的东西与仓库里已有的一致。升级字体是一次显式的、
// 要重跑 src/fonts.test.ts 的改动。
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FontSource {
  /** 令牌与文件名用的 id（小写 kebab）。 */
  id: string;
  /** 字体内部家族名——**必须与文件里的 name ID 1 逐字一致**，CSS 里也用这个。
   *  Monaspace 有 Reserved Font Name，上游 NF 版已改名为 MonaspiceNe，不得写回。 */
  family: string;
  /** 归档下载地址，钉死 tag。 */
  url: string;
  /** 归档里 Regular / Bold 的路径（相对解包根）。 */
  regular: string;
  bold: string;
  /** 归档里授权原文的路径；null 表示随包没有，从 licenseUrl 单独取。 */
  license: string | null;
  licenseUrl?: string;
}

/** 终端真正会用到的字符：Latin-1 + 标点 + 箭头 + 制表符 + 块 + 几何 + 杂项符号
 *  + 盲文 + Powerline。CJK 不在这里——它走 OS 回落（见 fonts.css 的回落链）。 */
export const SUBSET_RANGES = [
  "U+0000-00FF", "U+0131", "U+0152-0153", "U+2000-206F", "U+20AC", "U+2122",
  "U+2190-21FF", "U+2212", "U+2215", "U+2500-259F", "U+25A0-25FF",
  "U+2600-26FF", "U+2800-28FF", "U+E0A0-E0D7", "U+FEFF", "U+FFFD",
].join(",");

const NF = "https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.0";

export const FONT_SOURCES: FontSource[] = [
  {
    id: "maple-mono",
    family: "Maple Mono NF",
    url: "https://github.com/subframe7536/maple-font/releases/download/v7.7/MapleMono-NF-unhinted.zip",
    regular: "MapleMono-NF-Regular.ttf",
    bold: "MapleMono-NF-Bold.ttf",
    license: "LICENSE.txt",
  },
  {
    id: "google-sans-code",
    family: "GoogleSansCode NFM",
    url: `${NF}/GoogleSansCode.tar.xz`,
    regular: "GoogleSansCodeNerdFontMono-Regular.ttf",
    bold: "GoogleSansCodeNerdFontMono-Bold.ttf",
    license: "OFL.txt",
  },
  {
    id: "monaspace-neon",
    family: "MonaspiceNe NFM",
    url: `${NF}/Monaspace.tar.xz`,
    regular: "MonaspiceNeNerdFontMono-Regular.otf",
    bold: "MonaspiceNeNerdFontMono-Bold.otf",
    license: "LICENSE",
  },
  {
    id: "ubuntu-mono",
    family: "UbuntuMono Nerd Font Mono",
    url: `${NF}/UbuntuMono.tar.xz`,
    regular: "UbuntuMonoNerdFontMono-Regular.ttf",
    bold: "UbuntuMonoNerdFontMono-Bold.ttf",
    license: "LICENCE.txt",
  },
];

const OUT_DIR = join(import.meta.dir, "../public/fonts");

function run(cmd: string[], cwd?: string): void {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) {
    throw new Error(`命令失败 (${r.exitCode}): ${cmd.join(" ")}\n${r.stderr.toString()}`);
  }
}

/** pyftsubset 处理 NF 字体时会崩在 BASE 表（struct.error: MinCoord），必须丢掉它。
 *  BASE 只影响基线对齐的高级排版，终端用不到。 */
function subset(input: string, output: string): void {
  run([
    "uv", "run", "--quiet", "--with", "fonttools", "--with", "brotli",
    "pyftsubset", input,
    `--unicodes=${SUBSET_RANGES}`,
    "--drop-tables+=BASE",
    "--flavor=woff2",
    `--output-file=${output}`,
  ]);
}

/**
 * 用 curl 而不是 fetch 下载。
 *
 * **不是风格选择**：Bun 的 fetch 在走 HTTP 代理时，响应头能正常返回（HEAD 请求
 * 1.2 秒拿到 200），但 `Bun.write(dest, res)` 消费响应体会永久挂起——一个字节都
 * 不落盘，也不报错、不超时。同一个 URL、同一个代理，curl 2.9 秒下完 20.5MB。
 * 2026-08-05 实测（Bun 1.x + clash 7890 端口）。
 *
 * curl 自己读 https_proxy/HTTPS_PROXY 环境变量，无需显式传 -x。
 */
function download(url: string, dest: string): void {
  run(["curl", "-sL", "--fail", "--max-time", "300", "-o", dest, url]);
}

function unpack(archive: string, dir: string): void {
  if (archive.endsWith(".zip")) run(["unzip", "-oq", archive, "-d", dir]);
  else run(["tar", "-xf", archive, "-C", dir]);
}

if (import.meta.main) {
  // 工具链缺失就明确报错退出，不静默产出半套字体。
  if (!Bun.which("uv")) {
    console.error("[build-fonts] 需要 uv（提供 fontTools + brotli）。装：brew install uv");
    process.exit(1);
  }
  if (!process.env.https_proxy && !process.env.HTTPS_PROXY) {
    console.warn("[build-fonts] 未设代理，GitHub 下载可能超时。建议：");
    console.warn("  export https_proxy=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890");
  }

  const tmp = mkdtempSync(join(tmpdir(), "ps-fonts-"));
  try {
    for (const f of FONT_SOURCES) {
      console.log(`[build-fonts] ${f.id} …`);
      const dir = join(tmp, f.id);
      run(["mkdir", "-p", dir]);
      const archive = join(dir, f.url.split("/").pop()!);
      download(f.url, archive);
      unpack(archive, dir);

      for (const [weight, rel] of [["regular", f.regular], ["bold", f.bold]] as const) {
        const src = join(dir, rel);
        if (!existsSync(src)) throw new Error(`归档里没有 ${rel}——上游改了文件名？`);
        const out = join(OUT_DIR, `${f.id}-${weight}.woff2`);
        subset(src, out);
        console.log(`  ${f.id}-${weight}.woff2  ${Bun.file(out).size} B`);
      }

      if (f.license) {
        const lic = join(dir, f.license);
        if (!existsSync(lic)) throw new Error(`归档里没有授权原文 ${f.license}`);
        copyFileSync(lic, join(OUT_DIR, `${f.id}-LICENSE.txt`));
      }
    }
    console.log("[build-fonts] 完成。产物已写入 app/public/fonts/，记得提交。");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
