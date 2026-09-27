// check if crypto.subtle is available
export const isCryptoSubtleAvailable =
  typeof window !== "undefined" &&
  window.crypto &&
  window.crypto.subtle;

type CryptoJS = typeof import("crypto-js");

// lazy load crypto-js
export const CryptoJSPromise: Promise<CryptoJS> | null =
  isCryptoSubtleAvailable ? null : getCryptoJS();

async function getCryptoJS(): Promise<CryptoJS> {
  return import("crypto-js");
}
