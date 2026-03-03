import CryptoJS from "crypto-js";

export const encryptSensitiveFields = (input: any) => {
    // Special handling for variables table - encrypt value if encrypted flag is true
    if (input.value && input.encrypted === true) {
      input.value = CryptoJS.AES.encrypt(
        input.value,
        process.env.NEXTAUTH_SECRET,
      ).toString();
    }
  
    return input;
  };