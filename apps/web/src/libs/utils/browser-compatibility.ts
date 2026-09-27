import { MIN_IOS_VERSION, MIN_VERSIONS } from "@/constants";

// Define the configuration object for browser detection rules
const BROWSER_RULES = [
  // iOS third-party browser
  {
    regex: /CriOS\/([\d.]+)/,
    engine: "Chrome iOS",
    versionIndex: 1,
    os: "iOS",
  },
  {
    regex: /FxiOS\/([\d.]+)/,
    engine: "Firefox iOS",
    versionIndex: 1,
    os: "iOS",
  },
  {
    regex: /EdgiOS\/([\d.]+)/,
    engine: "Edge iOS",
    versionIndex: 1,
    os: "iOS",
  },
  {
    regex: /OPiOS\/([\d.]+)/,
    engine: "Opera iOS",
    versionIndex: 1,
    os: "iOS",
  },

  // Desktop & Android
  {
    regex: /Chrome\/([\d.]+)/,
    engine: "Chrome",
    versionIndex: 1,
    os: /Windows NT|Linux|Mac OS X/,
  },
  {
    regex: /Firefox\/([\d.]+)/,
    engine: "Firefox",
    versionIndex: 1,
  },
  {
    regex: /Edg\/([\d.]+)/,
    engine: "Edge",
    versionIndex: 1,
  },
  {
    regex: /OPR\/([\d.]+)/,
    engine: "Opera",
    versionIndex: 1,
  },

  // Safari
  {
    regex: /Version\/([\d.]+).+Safari/,
    engine: "Safari",
    versionIndex: 1,
    os: (ua: string) =>
      /iPad|iPhone|iPod/.test(ua) ? "iOS" : "macOS",
  },
];

const getVersion = (
  ua: string,
  regex: RegExp,
  index: number,
) => {
  const match = ua.match(regex);
  return match?.[index] || "unknown";
};

function getBrowserEngineInfo() {
  const ua = navigator.userAgent;
  let engineInfo = {
    engine: "unknown",
    version: "unknown",
    os: "unknown",
    osVersion: "",
  };

  for (const rule of BROWSER_RULES) {
    if (rule.regex.test(ua)) {
      const os =
        typeof rule.os === "function"
          ? rule.os(ua)
          : rule.os || "";

      engineInfo = {
        engine: rule.engine,
        version: getVersion(
          ua,
          rule.regex,
          rule.versionIndex,
        ),
        os: os.toString(),
        osVersion: os === "iOS" ? getiOSVersion() : "",
      };
      break;
    }
  }

  return engineInfo;
}

function getiOSVersion() {
  const match = navigator.userAgent.match(
    /OS (\d+)_(\d+)(?:_(\d+))?/,
  );
  if (!match) return "unknown";
  return [match[1], match[2], match[3] || "0"].join(".");
}

function compareVersions(current: string, target: string) {
  const normalize = (v: string) =>
    v.split(".").map(Number).concat([0, 0, 0]).slice(0, 3);

  const currentParts = normalize(current);
  const targetParts = normalize(target);

  for (let i = 0; i < 3; i++) {
    if (currentParts[i] < targetParts[i]) return false;
    if (currentParts[i] > targetParts[i]) return true;
  }
  return true;
}

export { MIN_VERSIONS };

export function checkBrowserSupport() {
  const { engine, version, os, osVersion } =
    getBrowserEngineInfo();

  if (os === "iOS") {
    return compareVersions(osVersion, MIN_IOS_VERSION);
  }

  const minVersion = MIN_VERSIONS[engine];
  if (!minVersion) return false;

  return compareVersions(version, minVersion);
}

export function isWebRTCAvailable() {
  return (
    "RTCPeerConnection" in window ||
    "webkitRTCPeerConnection" in window ||
    "mozRTCPeerConnection" in window
  );
}
