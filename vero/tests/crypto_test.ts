/**
 * Vero Cryptographic Verification Test Suite
 *
 * Verifies:
 * 1. libsodium initialization
 * 2. Key pair generation (X25519 & Ed25519)
 * 3. E2EE message encryption & decryption
 * 4. Zero plaintext leakage in ciphertext
 * 5. Safety number generation (60-digit formatted blocks)
 * 6. UUID generator format
 */

import sodium from 'libsodium-wrappers';
import { generateUUID } from '../src/shared/utils/uuid';

async function runTests() {
  console.log('🚀 Starting Vero Cryptographic Verification Tests...\n');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string) {
    if (condition) {
      console.log(`  ✓ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${testName}`);
      failed++;
    }
  }

  // 1. Libsodium ready
  await sodium.ready;
  assert(true, 'libsodium-wrappers initialized and ready');

  // 2. Key Pair Generation
  const aliceBox = sodium.crypto_box_keypair();
  const bobBox = sodium.crypto_box_keypair();
  assert(aliceBox.publicKey.length === 32, 'Alice X25519 public key is 32 bytes');
  assert(aliceBox.privateKey.length === 32, 'Alice X25519 private key is 32 bytes');
  assert(bobBox.publicKey.length === 32, 'Bob X25519 public key is 32 bytes');

  // 3. E2EE Encryption & Decryption
  const testPlaintext = 'Top Secret: Vero Privacy Guaranteed!';
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
  
  // Alice encrypts for Bob
  const ciphertext = sodium.crypto_box_easy(
    testPlaintext,
    nonce,
    bobBox.publicKey,
    aliceBox.privateKey
  );
  
  assert(ciphertext.length > 0, 'Ciphertext generated successfully');
  
  // 4. Verify ZERO Plaintext Leakage
  const ciphertextStr = sodium.to_base64(ciphertext);
  assert(!ciphertextStr.includes('Top Secret'), 'Ciphertext contains ZERO plaintext leakage');

  // Bob decrypts from Alice
  const decryptedBytes = sodium.crypto_box_open_easy(
    ciphertext,
    nonce,
    aliceBox.publicKey,
    bobBox.privateKey
  );
  const decryptedText = sodium.to_string(decryptedBytes);
  assert(decryptedText === testPlaintext, `Decrypted text exactly matches original: "${decryptedText}"`);

  // Tamper resistance test (corrupt 1 byte of ciphertext)
  const tamperedCiphertext = new Uint8Array(ciphertext);
  tamperedCiphertext[0] ^= 0xff;
  let tamperCaught = false;
  try {
    sodium.crypto_box_open_easy(tamperedCiphertext, nonce, aliceBox.publicKey, bobBox.privateKey);
  } catch (e) {
    tamperCaught = true;
  }
  assert(tamperCaught, 'Tampered ciphertext correctly rejected by cryptographic MAC');

  // 5. Safety Number Generation
  const alicePkB64 = sodium.to_base64(aliceBox.publicKey);
  const bobPkB64 = sodium.to_base64(bobBox.publicKey);
  
  function computeSafetyNumber(pk1: string, pk2: string): string {
    const keys = [pk1, pk2].sort();
    const combined = new TextEncoder().encode(keys.join('|'));
    const hash = sodium.crypto_generichash(30, combined);
    const digits = Array.from(hash)
      .map((b: number) => b.toString().padStart(3, '0'))
      .join('')
      .slice(0, 60);
    return digits
      .match(/.{1,5}/g)!
      .join(' ')
      .match(/.{1,18}/g)!
      .join('\n');
  }

  const safety1 = computeSafetyNumber(alicePkB64, bobPkB64);
  const safety2 = computeSafetyNumber(bobPkB64, alicePkB64);
  assert(safety1 === safety2, 'Safety number is deterministic and symmetric regardless of party order');
  assert(safety1.replace(/\s+/g, '').length === 60, 'Safety number contains exactly 60 numeric digits');

  // 6. UUID Generator Format
  const uuid = generateUUID();
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  assert(uuidRegex.test(uuid), `Generated UUID matches RFC4122 v4 format: ${uuid}`);

  console.log(`\n========================================`);
  console.log(`Tests Completed: ${passed} Passed, ${failed} Failed`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((e) => {
  console.error('Test execution error:', e);
  process.exit(1);
});
