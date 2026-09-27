import CryptoJS from "crypto-js";
onmessage = async (event) => {
  const { type, data } = event.data;

  if (type === "encryptData") {
    const { password, data: plaintext } = data;
    const encryptedData = await encryptData(
      password,
      plaintext,
    );
    postMessage({
      type: "encryptData",
      data: encryptedData,
    });
  } else if (type === "decryptData") {
    const { password, data: encryptedData } = data;
    const decryptedData = await decryptData(
      password,
      encryptedData,
    );
    postMessage({
      type: "decryptData",
      data: decryptedData,
    });
  } else if (type === "hashPassword") {
    const { password, saltLength, iterations } = data;
    const hashedPassword = await hashPassword(
      password,
      saltLength,
      iterations,
    );
    postMessage({
      type: "hashPassword",
      data: hashedPassword,
    });
  } else if (type === "comparePasswordHash") {
    const { password, storedHash, saltLength, iterations } =
      data;
    const isMatch = await comparePasswordHash(
      password,
      storedHash,
      saltLength,
      iterations,
    );
    postMessage({
      type: "comparePasswordHash",
      data: isMatch,
    });
  } else {
    throw new Error("Invalid type");
  }
};

async function getRandomBytes(length: number) {
  const randomWords =
    CryptoJS.lib.WordArray.random(length).words;
  const randomBytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    randomBytes[i] =
      (randomWords[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
  }
  return randomBytes;
}

async function hashPassword(
  password: string,
  saltLength = 16,
  iterations = 100000,
) {
  // generate random salt
  const salt = await getRandomBytes(saltLength);

  // derive key
  const key = CryptoJS.PBKDF2(
    password,
    CryptoJS.lib.WordArray.create(salt),
    {
      keySize: 256 / 32,
      iterations: iterations,
      hasher: CryptoJS.algo.SHA256,
    },
  );

  // combine salt and hash
  const combinedWordArray =
    CryptoJS.lib.WordArray.create(salt).concat(key);

  // return base64 encoded string
  return CryptoJS.enc.Base64.stringify(combinedWordArray);
}

async function comparePasswordHash(
  password: string,
  storedHash: string,
  saltLength = 16,
  iterations = 100000,
) {
  try {
    // decode base64
    const combinedWordArray =
      CryptoJS.enc.Base64.parse(storedHash);

    // extract salt and hash
    const saltWords = CryptoJS.lib.WordArray.create(
      combinedWordArray.words.slice(0, saltLength / 4),
      saltLength,
    );

    const storedHashWords = CryptoJS.lib.WordArray.create(
      combinedWordArray.words.slice(saltLength / 4),
    );

    // derive hash
    const derivedKey = CryptoJS.PBKDF2(
      password,
      saltWords,
      {
        keySize: 256 / 32,
        iterations: iterations,
        hasher: CryptoJS.algo.SHA256,
      },
    );

    // compare hash
    return (
      CryptoJS.enc.Hex.stringify(derivedKey) ===
      CryptoJS.enc.Hex.stringify(storedHashWords)
    );
  } catch (error) {
    console.error("Error comparing password:", error);
    throw new Error("Failed to compare password");
  }
}

// 修改后的encryptData函数
async function encryptData(password: string, data: string) {
  // create random salt and iv
  const salt = await getRandomBytes(16);
  const iv = await getRandomBytes(16);

  // derive key
  const key = CryptoJS.PBKDF2(
    password,
    CryptoJS.lib.WordArray.create(salt),
    {
      keySize: 256 / 32,
      iterations: 100000,
      hasher: CryptoJS.algo.SHA256,
    },
  );

  // encrypt data
  const encrypted = CryptoJS.AES.encrypt(data, key, {
    iv: CryptoJS.lib.WordArray.create(iv),
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });

  // combine salt, iv and ciphertext
  const combinedWordArray = CryptoJS.lib.WordArray.create(
    salt,
  )
    .concat(CryptoJS.lib.WordArray.create(iv))
    .concat(encrypted.ciphertext);

  return CryptoJS.enc.Base64.stringify(combinedWordArray);
}

// 修改后的decryptData函数
async function decryptData(
  password: string,
  encryptedData: string,
) {
  // decode base64
  const combinedWordArray =
    CryptoJS.enc.Base64.parse(encryptedData);

  // extract salt, iv and ciphertext
  const salt = CryptoJS.lib.WordArray.create(
    combinedWordArray.words.slice(0, 4),
    16,
  );
  const iv = CryptoJS.lib.WordArray.create(
    combinedWordArray.words.slice(4, 8),
    16,
  );
  const ciphertext = CryptoJS.lib.WordArray.create(
    combinedWordArray.words.slice(8),
  );

  // derive key
  const key = CryptoJS.PBKDF2(password, salt, {
    keySize: 256 / 32,
    iterations: 100000,
    hasher: CryptoJS.algo.SHA256,
  });

  // decrypt
  const decrypted = CryptoJS.AES.decrypt(
    { ciphertext: ciphertext } as any,
    key,
    {
      iv: iv,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    },
  );

  // decode to string
  return decrypted.toString(CryptoJS.enc.Utf8);
}
