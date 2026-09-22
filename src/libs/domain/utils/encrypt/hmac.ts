import {
  isCryptoSubtleAvailable,
  CryptoJSPromise,
} from ".";

// generateHMAC function
export async function generateHMAC(
  key: string,
  message: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(key);
  const messageData = encoder.encode(message);

  if (isCryptoSubtleAvailable) {
    // Use Web Crypto API
    const cryptoKey = await window.crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"],
    );
    const signature = await window.crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      messageData,
    );
    return arrayBufferToBase64(signature);
  } else {
    // Replace with crypto-js as an alternative
    const CryptoJS = await CryptoJSPromise;
    if (!CryptoJS) {
      throw new Error("CryptoJS is not available");
    }
    const keyWordArray = CryptoJS.enc.Utf8.parse(key);
    const messageWordArray =
      CryptoJS.enc.Utf8.parse(message);
    const hash = CryptoJS.HmacSHA1(
      messageWordArray,
      keyWordArray,
    );
    return CryptoJS.enc.Base64.stringify(hash);
  }
}

// arrayBuffer to base64
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
