// req: 交互式向导里的依赖静默安装决策。
//
// 策略按**语境**分流，不按依赖种类：
//   - 非交互路径（cli-entry.ts 的 runBoot，可能被 systemd/launchd 拉起）
//     维持 fail-loud，一字不改；
//   - 交互式向导（install / tunnel setup）默认静默安装。
// 理由：用户在 install 里已经允许我们 sudo 写 systemd unit 并开机自启，装服务
// 的权限远大于装依赖，此时说「不擅自装依赖」不自洽。
//
// 门禁是 TTY：curl | sh 的管道里 stdin 不是终端，那种语境下一律回落手工指引
// （同 install.sh 不自动装服务的理由）。
//
// 本文件只做**决策**，不执行。执行在 tunnel-runner.ts，且一律 argv 数组。

/**
 * 官方安装脚本。
 *
 * 信任链要诚实说清楚：这是 `curl | sh` 跑第三方脚本，与我们自己的 install.sh
 * 同构、同样是自指的信任模型（config.ts 里 POCKETSHELL_UPDATE_REPO 那段已有
 * 先例）。它防不了任何攻击者，只防传输损坏。
 *
 * 为什么不像 cloudflared 那样直下裸二进制：tailscale 需要一个常驻 daemon
 * (tailscaled) 并注册为系统服务，裸二进制干不了这件事。
 */
export const TAILSCALE_INSTALL_URL = "https://tailscale.com/install.sh";

export type DepDecision =
  | { action: "present" }
  | { action: "install"; argv: string[][] }
  | { action: "manual"; message: string };

export interface DepInput {
  /** `tailscale version` 是否成功。 */
  present: boolean;
  platform: string;
  /** process.stdin.isTTY */
  isTTY: boolean;
  euid: number;
  /** 安装脚本落盘位置（由调用方给，保持本函数纯净）。 */
  scriptPath: string;
}

const MANUAL_LINUX = (url: string) =>
  [
    "Tailscale is not installed, and this is not an interactive terminal, so nothing was installed.",
    "Install it yourself, then re-run `sudo pocketshell-agent tunnel setup`:",
    `    curl -fsSL ${url} | sh`,
  ].join("\n");

export function decideTailscaleInstall(i: DepInput): DepDecision {
  if (i.present) return { action: "present" };

  if (i.platform === "darwin") {
    return {
      action: "manual",
      message: [
        "Tailscale is not installed.",
        "On macOS it ships as an app with its own background service, so this installer will not put it there for you.",
        "Install it, sign in once, then re-run `pocketshell-agent tunnel setup`:",
        "    brew install tailscale",
        "    sudo brew services start tailscale",
        "(The Mac App Store build works too, but it does not provide the `tailscale` command this setup needs.)",
      ].join("\n"),
    };
  }

  if (i.platform !== "linux") {
    return {
      action: "manual",
      message: `Tailscale is not installed, and automatic installation is only supported on Linux (this is ${i.platform}).\nSee ${TAILSCALE_INSTALL_URL}`,
    };
  }

  if (!i.isTTY) return { action: "manual", message: MANUAL_LINUX(TAILSCALE_INSTALL_URL) };

  if (i.euid !== 0) {
    return {
      action: "manual",
      message: [
        "Tailscale is not installed, and installing it needs root.",
        "Re-run with sudo: sudo pocketshell-agent tunnel setup",
      ].join("\n"),
    };
  }

  // 下载与执行分成两条 argv，而不是 `curl … | sh`：管道要 shell，而 shell 串
  // 是本仓库的禁区（install-runner.ts:5-8 记录了它吞输入且退出码为 0 的前科）。
  return {
    action: "install",
    argv: [
      ["curl", "-fsSL", "-o", i.scriptPath, TAILSCALE_INSTALL_URL],
      ["sh", i.scriptPath],
    ],
  };
}
