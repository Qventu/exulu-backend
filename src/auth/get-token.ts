import { jwtVerify, importJWK } from "jose";

export const getToken = async (authHeader: string) => {
    const token = authHeader.split(' ')[1];
    if (!token) {
        throw new Error("No token provided for user authentication in headers.")
    }
    if (!process.env.NEXTAUTH_SECRET) {
        throw new Error("No NEXTAUTH_SECRET provided")
    }
    try {
        // Note: This secret is same as NextAuth Secret.
        const secret = process.env.NEXTAUTH_SECRET
        const jwk = await importJWK({ k: secret, alg: 'HS256', kty: 'oct' });
        const { payload } = await jwtVerify(token, jwk);
        return payload;
    } catch (error) {
        throw new Error("Invalid token")
    }
}