import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

/**
 * Parse a private key string into a Keypair object.
 * @param privateKey - The private key string to parse in bs58 or uint8array format.
 * @returns A Keypair object.
 */
export function parseKeypairSync(privateKey: string): Keypair {
  try {
    if (privateKey.startsWith('[')) {
      const keyStr = JSON.parse(privateKey);

      return Keypair.fromSeed(Buffer.from(keyStr).subarray(0, 32));
    }

    const decodedKey = bs58.decode(privateKey);

    const keyArr = new Uint8Array(
      decodedKey.buffer,
      decodedKey.byteOffset,
      decodedKey.byteLength / Uint8Array.BYTES_PER_ELEMENT,
    );

    return Keypair.fromSecretKey(keyArr);
  } catch (error) {
    throw new Error('Invalid private key');
  }
}
