export async function hashPassword(
  password: string,
  saltLength: number = 16,
  iterations: number = 100000,
  hash: string = "SHA-256",
): Promise<string> {
  // generate random salt
  const salt = crypto.getRandomValues(
    new Uint8Array(saltLength),
  );

  // encode password to ArrayBuffer
  const encoder = new TextEncoder();
  const passwordBuffer = encoder.encode(password);

  // derive key from password
  const key = await crypto.subtle.importKey(
    "raw",
    passwordBuffer,
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: iterations,
      hash: hash,
    },
    key,
    256,
  );

  // combine salt and hash
  const combined = new Uint8Array([
    ...salt,
    ...new Uint8Array(derivedBits),
  ]);
  return btoa(String.fromCharCode(...combined));
}

// check if the string is a valid base64 string
function isValidBase64String(str: string) {
  const base64Regex = /^[A-Za-z0-9+/]+={0,2}$/;
  return str.length % 4 === 0 && base64Regex.test(str);
}

// compare password hash
export async function comparePasswordHash(
  password: string,
  storedHash: string,
  saltLength: number = 16,
  iterations: number = 100000,
  hash = "SHA-256",
): Promise<boolean> {
  if (!isValidBase64String(storedHash)) {
    throw new Error("Invalid Base64 string");
  }
  try {
    // decode base64
    const combined = Uint8Array.from(
      atob(storedHash),
      (c) => c.charCodeAt(0),
    );

    // extract salt
    const salt = combined.slice(0, saltLength);

    // extract stored hash
    const storedPasswordHash = combined.slice(saltLength);

    // rehash the input password
    const encoder = new TextEncoder();
    const passwordBuffer = encoder.encode(password);

    const key = await crypto.subtle.importKey(
      "raw",
      passwordBuffer,
      { name: "PBKDF2" },
      false,
      ["deriveBits"],
    );

    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: salt,
        iterations: iterations,
        hash: hash,
      },
      key,
      256,
    );

    // compare two hash
    const derivedHash = new Uint8Array(derivedBits);
    return derivedHash.every(
      (byte, index) => byte === storedPasswordHash[index],
    );
  } catch (error) {
    console.error("Error comparing password:", error);
    throw new Error("Failed to compare password");
  }
}

export async function encryptData(
  password: string,
  data: string,
): Promise<string> {
  // create random salt and iv
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // derive key from password
  const keyMaterial = await getKeyMaterial(password);
  const key = await deriveKey(keyMaterial, salt);

  // encode data to Uint8Array
  const encoder = new TextEncoder();
  const encodedData = encoder.encode(data);

  // encrypt data
  const encryptedData = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv,
    },
    key,
    encodedData,
  );

  // combine encrypted data, salt and iv
  const combinedData = new Uint8Array([
    ...salt,
    ...iv,
    ...new Uint8Array(encryptedData),
  ]);
  return btoa(String.fromCharCode(...combinedData));
}

async function getKeyMaterial(
  password: string,
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
}

async function deriveKey(
  keyMaterial: CryptoKey,
  salt: Uint8Array,
): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function decryptData(
  password: string,
  encryptedData: string,
): Promise<string> {
  // decode base64 data
  const combinedData = Uint8Array.from(
    atob(encryptedData),
    (c) => c.charCodeAt(0),
  );

  // extract salt, iv and ciphertext
  const salt = combinedData.slice(0, 16);
  const iv = combinedData.slice(16, 28);
  const ciphertext = combinedData.slice(28);

  // derive key from password
  const keyMaterial = await getKeyMaterial(password);
  const key = await deriveKey(keyMaterial, salt);

  // decrypt data
  const decryptedData = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: iv,
    },
    key,
    ciphertext,
  );

  // decode data to string
  const decoder = new TextDecoder();
  return decoder.decode(decryptedData);
}
