import { jwtVerify, importJWK } from "jose";

export const getToken = async (authHeader: string) => {
  const token = authHeader.split(" ")[1];
  if (!token) {
    throw new Error("No token provided for user authentication in headers.");
  }
  if (!process.env.NEXTAUTH_SECRET) {
    throw new Error("No NEXTAUTH_SECRET provided");
  }
  try {
    // Note: This secret is same as NextAuth Secret.
    // Convert the secret to base64url format as required by jose
    const secret = process.env.NEXTAUTH_SECRET;
    const secretBuffer = Buffer.from(secret, "utf-8");
    const base64Secret = secretBuffer.toString("base64url");
    const jwk = await importJWK({ k: base64Secret, alg: "HS256", kty: "oct" });
    const { payload } = await jwtVerify(token, jwk);
    return payload;
  } catch (error) {
    console.error("Invalid token error in getToken", error);
    throw new Error("Invalid token");
  }
};
