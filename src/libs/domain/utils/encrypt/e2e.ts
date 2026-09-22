import { isCryptoSubtleAvailable } from ".";

const base64Regex = /^[A-Za-z0-9+/]+={0,2}$/;
// check if the base64 string is valid
function isValidBase64String(str: string) {
  return str.length % 4 === 0 && base64Regex.test(str);
}

// modified hashPassword function
export async function hashPassword(
  password: string,
  saltLength = 16,
  iterations = 100000,
  hash = "SHA-256",
): Promise<string> {
  if (isCryptoSubtleAvailable) {
    // using Web Crypto API
    // generate random salt
    const salt = crypto.getRandomValues(
      new Uint8Array(saltLength),
    );

    // encode password
    const encoder = new TextEncoder();
    const passwordBuffer = encoder.encode(password);

    // import key
    const key = await crypto.subtle.importKey(
      "raw",
      passwordBuffer,
      { name: "PBKDF2" },
      false,
      ["deriveBits"],
    );

    // derive bits
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
  } else {
    const EncryptWorker =
      await import("./encrypt-worker?worker").then(
        (module) => module.default,
      );
    // using crypto-js
    const worker = new EncryptWorker();
    worker.postMessage({
      type: "hashPassword",
      data: { password, saltLength, iterations },
    });

    return new Promise((resolve, reject) => {
      worker.onmessage = (event) => {
        resolve(event.data.data);
        worker.terminate();
      };
      worker.onerror = (error) => {
        reject(error);
        worker.terminate();
      };
    });
  }
}

// modified comparePasswordHash function
export async function comparePasswordHash(
  password: string,
  storedHash: string,
  saltLength = 16,
  iterations = 100000,
  hash = "SHA-256",
): Promise<boolean> {
  if (!isValidBase64String(storedHash)) {
    throw new Error("Invalid Base64 string");
  }

  if (isCryptoSubtleAvailable) {
    // Using Web Crypto API
    try {
      // decode base64
      const combined = Uint8Array.from(
        atob(storedHash),
        (c) => c.charCodeAt(0),
      );

      // extract salt and hash
      const salt = combined.slice(0, saltLength);
      const storedPasswordHash = combined.slice(saltLength);

      // derive hash
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

      const derivedHash = new Uint8Array(derivedBits);

      // compare hash
      return derivedHash.every(
        (byte, index) => byte === storedPasswordHash[index],
      );
    } catch (error) {
      console.error("Error comparing password:", error);
      throw new Error("Failed to compare password");
    }
  } else {
    const EncryptWorker =
      await import("./encrypt-worker?worker").then(
        (module) => module.default,
      );
    const worker = new EncryptWorker();
    worker.postMessage({
      type: "comparePasswordHash",
      data: {
        password,
        storedHash,
        saltLength,
        iterations,
      },
    });

    return new Promise((resolve, reject) => {
      worker.onmessage = (event) => {
        resolve(event.data.data);
        worker.terminate();
      };
      worker.onerror = (error) => {
        reject(error);
        worker.terminate();
      };
    });
  }
}

// modified encryptData function
export async function encryptData(
  password: string,
  data: string,
): Promise<string> {
  if (isCryptoSubtleAvailable) {
    // using Web Crypto API
    // create random salt and iv
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));

    // derive key
    const keyMaterial = await getKeyMaterial(password);
    const key = await deriveKey(keyMaterial, salt.buffer);

    // encrypt data
    const encoder = new TextEncoder();
    const encodedData = encoder.encode(data);
    const encryptedData = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv,
      },
      key,
      encodedData,
    );

    // combine salt, iv and ciphertext
    const combinedData = new Uint8Array([
      ...salt,
      ...iv,
      ...new Uint8Array(encryptedData),
    ]);
    return btoa(String.fromCharCode(...combinedData));
  } else {
    const EncryptWorker =
      await import("./encrypt-worker?worker").then(
        (module) => module.default,
      );
    const worker = new EncryptWorker();
    worker.postMessage({
      type: "encryptData",
      data: { password, data },
    });
    return new Promise((resolve, reject) => {
      worker.onmessage = (event) => {
        resolve(event.data.data);
        worker.terminate();
      };
      worker.onerror = (error) => {
        reject(error);
        worker.terminate();
      };
    });
  }
}

// modified decryptData function
export async function decryptData(
  password: string,
  encryptedData: string,
): Promise<string> {
  if (isCryptoSubtleAvailable) {
    // using Web Crypto API
    // decode base64
    const combinedData = Uint8Array.from(
      atob(encryptedData),
      (c) => c.charCodeAt(0),
    );

    // extract salt, iv and ciphertext
    const salt = combinedData.slice(0, 16);
    const iv = combinedData.slice(16, 28);
    const ciphertext = combinedData.slice(28);

    // derive key
    const keyMaterial = await getKeyMaterial(password);
    const key = await deriveKey(keyMaterial, salt.buffer);

    // decrypt
    const decryptedData = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv,
      },
      key,
      ciphertext,
    );

    // decode to string
    const decoder = new TextDecoder();
    return decoder.decode(decryptedData);
  } else {
    const EncryptWorker =
      await import("./encrypt-worker?worker").then(
        (module) => module.default,
      );
    const worker = new EncryptWorker();
    worker.postMessage({
      type: "decryptData",
      data: { password, data: encryptedData },
    });
    return new Promise((resolve, reject) => {
      worker.onmessage = (event) => {
        resolve(event.data.data);
        worker.terminate();
      };
      worker.onerror = (error) => {
        reject(error);
        worker.terminate();
      };
    });
  }
}

// helper function: get key material
async function getKeyMaterial(
  password: string,
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const encodedPassword = encoder.encode(password);
  if (isCryptoSubtleAvailable) {
    return crypto.subtle.importKey(
      "raw",
      encodedPassword,
      "PBKDF2",
      false,
      ["deriveKey"],
    );
  } else {
    // in crypto-js, this step is not needed
    throw new Error(
      "getKeyMaterial is not needed when using crypto-js",
    );
  }
}

// helper function: derive key
async function deriveKey(
  keyMaterial: CryptoKey,
  salt: ArrayBuffer,
): Promise<CryptoKey> {
  if (isCryptoSubtleAvailable) {
    return window.crypto.subtle.deriveKey(
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
  } else {
    throw new Error(
      "deriveKey is not needed when using crypto-js",
    );
  }
}
