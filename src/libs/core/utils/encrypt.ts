export async function hashPassword(
  password: string,
  saltLength: number = 16,
  iterations: number = 100000,
  hash: string = "SHA-256",
): Promise<string> {
  // 生成随机盐
  const salt = crypto.getRandomValues(
    new Uint8Array(saltLength),
  );

  // 将密码和盐转成 ArrayBuffer
  const encoder = new TextEncoder();
  const passwordBuffer = encoder.encode(password);

  // 使用 PBKDF2 算法进行密码哈希
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

  // 将盐和哈希值组合，编码为 Base64 字符串
  const combined = new Uint8Array([
    ...salt,
    ...new Uint8Array(derivedBits),
  ]);
  return btoa(String.fromCharCode(...combined));
}

function isValidBase64String(str: string) {
  // 检查字符串是否只包含合法的 Base64 字符，且长度是 4 的倍数
  const base64Regex = /^[A-Za-z0-9+/]+={0,2}$/;
  return str.length % 4 === 0 && base64Regex.test(str);
}

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
    // 解码 Base64
    const combined = Uint8Array.from(
      atob(storedHash),
      (c) => c.charCodeAt(0),
    );

    // 提取盐
    const salt = combined.slice(0, saltLength);

    // 提取存储的哈希值
    const storedPasswordHash = combined.slice(saltLength);

    // 重新哈希输入的密码
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

    // 比较两个哈希值
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
  // 创建随机的盐和初始化向量（IV）
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // 使用 PBKDF2 算法将密码派生成 AES 密钥
  const keyMaterial = await getKeyMaterial(password);
  const key = await deriveKey(keyMaterial, salt);

  // 将数据转换成 Uint8Array
  const encoder = new TextEncoder();
  const encodedData = encoder.encode(data);

  // 使用 AES-GCM 进行加密
  const encryptedData = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv,
    },
    key,
    encodedData,
  );

  // 将加密结果、盐和 IV 组合并编码为 Base64
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
  // 解码 Base64 数据
  const combinedData = Uint8Array.from(
    atob(encryptedData),
    (c) => c.charCodeAt(0),
  );

  // 提取盐、IV 和加密数据
  const salt = combinedData.slice(0, 16);
  const iv = combinedData.slice(16, 28);
  const ciphertext = combinedData.slice(28);

  // 使用 PBKDF2 派生密钥
  const keyMaterial = await getKeyMaterial(password);
  const key = await deriveKey(keyMaterial, salt);

  // 使用 AES-GCM 进行解密
  const decryptedData = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: iv,
    },
    key,
    ciphertext,
  );

  // 将解密后的数据转换回字符串
  const decoder = new TextDecoder();
  return decoder.decode(decryptedData);
}
