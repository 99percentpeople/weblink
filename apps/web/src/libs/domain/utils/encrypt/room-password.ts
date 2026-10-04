import { randomBytes } from "./bytes";

export function generateRoomPassword(): string {
  let password = "";
  while (password.length < 6) {
    for (const byte of randomBytes(6 - password.length)) {
      // Reject the incomplete group so each decimal digit is equally likely.
      if (byte < 250) password += String(byte % 10);
    }
  }
  return password;
}
