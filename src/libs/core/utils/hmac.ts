export async function generateHMAC(
  key: string,
  message: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(key);
  const messageData = encoder.encode(message);

  return window.crypto.subtle
    .importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"],
    )
    .then((cryptoKey) => {
      return window.crypto.subtle.sign(
        "HMAC",
        cryptoKey,
        messageData,
      );
    })
    .then((signature) => {
      return arrayBufferToBase64(signature);
    });
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
