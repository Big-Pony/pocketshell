// 顶栏实例名前缀。分隔符与 agent 侧 instance-brand.ts 的 SEP 保持一致。
// 顶栏横向空间紧张（右侧还有版本号、更新徽标、连接点、全屏按钮），
// 超长名字必须截断，否则会把这些控件挤出屏幕。
const SEP = " · ";
const MAX = 8;

export function brandPrefix(name: string | null | undefined): string {
  const s = (name ?? "").trim();
  if (!s) return "";
  return `${s.length > MAX ? s.slice(0, MAX) : s}${SEP}`;
}
