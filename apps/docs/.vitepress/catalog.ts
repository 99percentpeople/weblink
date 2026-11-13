export type Locale = "zh" | "en";

export interface DocPage {
  route: string;
  section: "guide" | "architecture" | "deployment";
  zh: string;
  en: string;
}

export const pages: DocPage[] = [
  {
    route: "index",
    section: "guide",
    zh: "快速开始",
    en: "Quick start",
  },
  {
    route: "guide/desktop",
    section: "guide",
    zh: "安装与使用桌面端",
    en: "Desktop app",
  },
  {
    route: "guide/rooms",
    section: "guide",
    zh: "房间与聊天",
    en: "Rooms & chat",
  },
  {
    route: "guide/files",
    section: "guide",
    zh: "文件传输与共享",
    en: "File transfers & sharing",
  },
  {
    route: "guide/storage",
    section: "guide",
    zh: "文件存储与管理",
    en: "File storage & management",
  },
  {
    route: "guide/media",
    section: "guide",
    zh: "音视频与录制",
    en: "Audio, video & recording",
  },
  {
    route: "guide/remote-control",
    section: "guide",
    zh: "远程桌面",
    en: "Remote desktop",
  },
  {
    route: "guide/device-trust",
    section: "guide",
    zh: "设备配对与权限",
    en: "Device pairing & permissions",
  },
  {
    route: "guide/automation",
    section: "guide",
    zh: "MCP 与自动化",
    en: "MCP & automation",
  },
  {
    route: "guide/connection",
    section: "guide",
    zh: "连接设置与测速",
    en: "Connection settings & speed tests",
  },
  {
    route: "guide/faq",
    section: "guide",
    zh: "常见问题",
    en: "Troubleshooting",
  },
  {
    route: "architecture/overview",
    section: "architecture",
    zh: "架构概览",
    en: "Architecture overview",
  },
  {
    route: "architecture/signaling",
    section: "architecture",
    zh: "信令与会话恢复",
    en: "Signaling & session recovery",
  },
  {
    route: "architecture/p2p-protocol",
    section: "architecture",
    zh: "P2P 控制协议",
    en: "P2P control protocol",
  },
  {
    route: "architecture/file-transfer",
    section: "architecture",
    zh: "文件传输与断点续传",
    en: "File transfer & resume",
  },
  {
    route: "architecture/media",
    section: "architecture",
    zh: "媒体传输与录制",
    en: "Media transport & recording",
  },
  {
    route: "architecture/codecs",
    section: "architecture",
    zh: "编码、解码与 GPU 显示",
    en: "Encoding, decoding & GPU display",
  },
  {
    route: "architecture/audio",
    section: "architecture",
    zh: "音频采集、编解码与播放",
    en: "Audio capture, codecs & playback",
  },
  {
    route: "architecture/device-trust",
    section: "architecture",
    zh: "设备身份与授权",
    en: "Device identity & authorization",
  },
  {
    route: "architecture/storage",
    section: "architecture",
    zh: "存储与文件生命周期",
    en: "Storage & file lifecycle",
  },
  {
    route: "deployment/overview",
    section: "deployment",
    zh: "自部署导读",
    en: "Self-hosting overview",
  },
  {
    route: "deployment/hosting",
    section: "deployment",
    zh: "Web 端部署",
    en: "Web deployment",
  },
  {
    route: "deployment/tauri",
    section: "deployment",
    zh: "Tauri 端部署",
    en: "Tauri deployment",
  },
  {
    route: "deployment/backend",
    section: "deployment",
    zh: "Server 部署",
    en: "Server deployment",
  },
  {
    route: "deployment/worker",
    section: "deployment",
    zh: "Worker 部署",
    en: "Worker deployment",
  },
];

// Detailed repository references and maintenance notes stay outside the public
// build; curated protocol articles live in architecture/.
// Uppercase files are legacy entry points.
export const sourceExcludes = [
  "README.md",
  "[A-Z]*.md",
  "development/**",
  "en/development/**",
  "reference/**",
  "en/reference/**",
];

export const repository =
  "https://github.com/99percentpeople/weblink";

export function pageLink(
  route: string,
  locale: Locale,
): string {
  const prefix = locale === "zh" ? "/zh/" : "/";
  return route === "index"
    ? prefix
    : prefix + route + ".html";
}
