# Secure Web ↔ App Secret Transfer Protocol
## Implementation Specification v0.1

> **Status:** Initial implementation specification  
> **Audience:** Codex / implementation agent  
> **Goal:** Implement a secure browser-to-application pairing mechanism and bidirectional transfer of domain-bound secrets using QR codes, HTTPS domain verification, WebRTC P2P transport, public-key cryptography, signatures, nonces, request identifiers, and proof of possession.

---

## 1. Objective

Build a system composed of:

- A web application running under a domain.
- A native/mobile application.
- A minimal public HTTPS endpoint on the domain used to verify pairing requests.
- A WebRTC P2P channel used for the actual application-to-web communication.
- A cryptographic identity for each App installation.
- A cryptographic identity for each participating domain.
- A local encrypted vault in the App containing secrets associated with domains.

The system must support:

1. Web → App initial pairing.
2. Domain ownership/request verification before trust is established.
3. Mutual cryptographic identity exchange over the authorized WebRTC session.
4. Web → App secure secret transfer.
5. App → Web secure secret retrieval.
6. Domain binding so a secret belonging to one domain cannot be requested by another domain.
7. Replay protection.
8. Proof of possession of the App private key.
9. Confidentiality and authenticity of transferred data.

---

# 2. Core Security Model

The architecture has three distinct security layers.

```text
QR + HTTPS
    │
    └── Verifies / authorizes the domain request

WebRTC
    │
    └── Provides P2P transport after pairing authorization

Cryptography
    │
    ├── App identity
    ├── Domain identity
    ├── Encryption
    ├── Signatures
    └── Proof of possession
```

WebRTC must NOT be treated as the application's sole identity mechanism.

The protocol must bind:

```text
domain
+
request_id
+
nonce
+
WebRTC session
+
App identity
+
operation
```

---

# 3. Cryptographic Identities

## 3.1 App Identity

On first installation, the App generates a persistent asymmetric key pair:

```text
App Private Key
App Public Key
```

Requirements:

- Private key MUST never leave the App.
- Private key SHOULD be stored using the platform secure key storage facility.
- Public key may be transmitted.
- App identity MUST have a stable identifier, `app_id`.
- `app_id` must not itself be treated as a secret.

Conceptually:

```text
APP
 ├── app_id
 ├── private_key     ← never exported
 └── public_key
```

## 3.2 Domain Identity

Each participating domain has a domain identity:

```text
domain_id
domain_private_key
domain_public_key
```

The domain private key MUST remain server-side.

The domain public key is delivered to the App during successful domain verification.

---

# 4. Initial Pairing

## 4.1 Web Creates Pairing Request

The Web creates a short-lived pairing request:

```text
request_id
nonce
domain
expiration
purpose = "PAIR"
```

The server stores the request as pending.

The request must be:

- unique;
- short-lived;
- single-use;
- associated with the domain;
- associated with the intended pairing operation.

## 4.2 QR Payload

The Web displays a QR containing at minimum:

```json
{
  "version": 1,
  "action": "PAIR",
  "domain": "dominio.com",
  "request_id": "...",
  "nonce": "..."
}
```

The QR must NOT contain:

- App private key;
- domain private key;
- secret;
- long-lived authentication credential.

---

# 5. Domain Verification

After scanning the QR, the App MUST independently contact the domain.

Conceptually:

```text
GET https://dominio.com/verificar/{request_id}
```

The App must not blindly trust an arbitrary verification URL supplied by the QR.

The domain verifies:

```text
request_id
nonce
domain
expiration
single-use status
purpose
```

If valid:

```text
HTTP 200
```

If invalid, expired, already consumed, or otherwise unauthorized:

```text
HTTP 403
```

The request MUST be consumed atomically so that it cannot be successfully verified twice.

---

# 6. Verification Response

On successful verification, the domain returns the information needed by the App to establish the domain identity.

Conceptually:

```json
{
  "status": "authorized",
  "version": 1,
  "domain_id": "...",
  "domain_public_key": "...",
  "request_id": "...",
  "nonce": "..."
}
```

The App verifies that:

```text
response.domain == QR.domain
response.request_id == QR.request_id
response.nonce == QR.nonce
```

The App then stores the trusted domain identity:

```text
domain_id
domain
domain_public_key
```

The public key is associated with that domain identity.

---

# 7. Proof of Possession

The App must prove possession of its private key without transmitting the private key.

The proof must be cryptographically bound to the current pairing.

Conceptually:

```text
proof = Sign(
    App Private Key,
    domain
    +
    request_id
    +
    nonce
    +
    pairing_context
)
```

The exact signature algorithm MUST use a standard, reviewed cryptographic primitive supported by the target platforms.

Do not invent a custom signature algorithm.

The proof must NOT expose the App private key.

The proof is later transmitted through the authorized WebRTC channel together with the App public key and App identifier.

---

# 8. WebRTC Establishment

After successful domain verification, WebRTC is established.

```text
APP ═══════════════════════════ WEB
              WebRTC
```

The WebRTC signaling mechanism may use the application's server infrastructure, but signaling must not be confused with the trusted P2P data channel.

The protocol must associate the WebRTC session with:

```text
domain
request_id
nonce
pairing operation
```

The session must not be accepted as an unrelated generic WebRTC connection.

---

# 9. Identity Exchange

Once the WebRTC data channel is established, the App sends:

```json
{
  "type": "APP_IDENTITY",
  "version": 1,
  "app_id": "...",
  "app_public_key": "...",
  "request_id": "...",
  "nonce": "...",
  "proof_of_possession": "..."
}
```

The Web verifies:

1. The request corresponds to an active pairing.
2. `request_id` matches.
3. `nonce` matches.
4. The domain is correct.
5. The proof is valid.
6. The proof corresponds to the supplied App public key.
7. The proof is bound to this pairing context.

The Web then records:

```text
app_id
app_public_key
domain_id
request_id
pairing timestamp
```

The Web responds with its domain identity:

```json
{
  "type": "DOMAIN_IDENTITY",
  "version": 1,
  "domain_id": "...",
  "domain_public_key": "...",
  "request_id": "...",
  "nonce": "..."
}
```

At this point the pairing is established.

---

# 10. Web → App Secret Transfer

The Web generates a cryptographically random secret.

```text
secret = CSPRNG(...)
```

The secret must never be sent in plaintext.

The Web encrypts the secret for the App using the App public key or, preferably for larger payloads, a standard hybrid encryption scheme:

```text
secret
   │
   ▼
random symmetric key
   │
   ├── encrypt secret
   │
   └── encrypt symmetric key with App Public Key
```

Use an authenticated encryption mode such as AES-GCM or ChaCha20-Poly1305.

Do not implement custom encryption.

The encrypted object is sent over WebRTC:

```text
WEB ═════════════ WebRTC ═════════════► APP
                         encrypted_secret
```

The App decrypts it with its private key and stores the secret locally.

---

# 11. Local Secret Storage

The App maintains a domain-bound secret store.

Conceptually:

```text
Vault
 ├── domain.com
 │     ├── domain_id
 │     ├── domain_public_key
 │     └── encrypted_secret
 │
 ├── another-domain.com
 │     ├── domain_id
 │     ├── domain_public_key
 │     └── encrypted_secret
 │
 └── ...
```

The App MUST NOT expose the secret merely because a request contains the correct domain string.

The stored secret must be cryptographically and logically associated with the domain identity.

---

# 12. Subsequent Secret Request

When the Web wants the App to return its secret, it creates another short-lived request:

```text
request_id
nonce
domain
purpose = "SECRET_REQUEST"
expiration
```

A QR is displayed:

```json
{
  "version": 1,
  "action": "SECRET_REQUEST",
  "domain": "dominio.com",
  "request_id": "...",
  "nonce": "..."
}
```

The App repeats the domain verification process.

It contacts:

```text
https://dominio.com/verificar/{request_id}
```

The domain verifies the request and returns its domain identity/public key.

The request is consumed after successful verification.

---

# 13. Domain Match

After successful verification, the App performs the critical domain match:

```text
QR domain
      │
      ▼
verified domain
      │
      ▼
stored domain identity
      │
      ▼
stored secret
```

The App may only release the secret if the verified domain corresponds to the domain identity under which the secret was originally stored.

Conceptually:

```text
requested_domain_id == stored_secret.domain_id
```

If not:

```text
DENY
```

No secret must be released.

---

# 14. App → Web Secret Transfer

The App retrieves the secret associated with the verified domain.

The App creates a response bound to the current request:

```json
{
  "version": 1,
  "request_id": "...",
  "nonce": "...",
  "domain_id": "...",
  "app_id": "...",
  "secret": "..."
}
```

The App signs the response using its private key:

```text
signature = Sign(
    App Private Key,
    canonical(response)
)
```

The response must include the current challenge/request context.

The resulting payload is then encrypted for the domain:

```text
payload + signature
        │
        ▼
Encrypt(Domain Public Key)
        │
        ▼
encrypted_response
```

The encrypted response is sent over WebRTC:

```text
APP ═════════════ WebRTC ═════════════► WEB
                         encrypted_response
```

The Web decrypts it using the Domain Private Key.

The Web verifies the App signature using the previously registered App public key.

---

# 15. Replay Protection

Every sensitive operation MUST use a fresh:

```text
request_id
nonce
```

Requests must have:

```text
expiration
single-use status
purpose
```

The signed/encrypted response must include the current request context.

A response from an earlier request MUST NOT be accepted for a new request.

Example:

```text
Request A
  nonce = AAA

Response A
  nonce = AAA
```

must not be accepted for:

```text
Request B
  nonce = BBB
```

---

# 16. Domain Binding

A secret is never identified merely by a human-readable domain string.

Use a stable domain identity:

```text
domain_id
domain_public_key
```

The secret record should reference the domain identity.

Conceptually:

```text
Secret
   │
   └── domain_id ──► Domain Identity
                         │
                         └── domain_public_key
```

This prevents:

```text
domain-A
   │
   └── secret-A
          │
          X
          │
domain-B attempting to obtain secret-A
```

---

# 17. WebRTC Security Requirements

WebRTC provides encrypted transport, but the application protocol MUST authenticate the participants independently.

The implementation must not assume:

```text
WebRTC encrypted = trusted participant
```

Instead:

```text
WebRTC encryption
+
pairing request validation
+
domain identity
+
App identity
+
proof of possession
```

must jointly establish trust.

The application protocol must bind the WebRTC session to the pairing request.

---

# 18. Security Properties Required

The implementation should satisfy these properties:

### Confidentiality

An observer of network traffic cannot obtain the secret.

### Authenticity

The Web can verify that an App response came from the App identity associated with the pairing.

### Domain authenticity

The App verifies that the request originates from the intended domain.

### Domain binding

A secret stored for domain A cannot be requested by domain B.

### App identity

The App has a persistent cryptographic identity.

### Proof of possession

The App can prove possession of its private key without revealing it.

### Integrity

Modification of encrypted or signed messages must be detected.

### Replay resistance

Old requests and responses cannot be reused.

### Request uniqueness

A request ID cannot be successfully consumed twice.

### Session binding

Messages from one WebRTC session cannot be transplanted into another pairing.

---

# 19. Failure Conditions

The App MUST reject the operation if any of these occur:

```text
request_id invalid
request_id expired
request_id already consumed
nonce mismatch
domain mismatch
domain identity mismatch
invalid domain public key
invalid App proof
invalid App signature
unknown App identity
unknown domain identity
WebRTC session not associated with request
wrong operation/purpose
decryption failure
authentication tag failure
challenge mismatch
secret not associated with verified domain
```

The Web MUST reject analogous invalid conditions.

Error responses should avoid revealing unnecessary information to an attacker.

---

# 20. Cryptographic Implementation Rules

Do not implement custom cryptography.

Use standard, audited platform/library primitives.

Prefer:

```text
CSPRNG
Authenticated Encryption
Standard digital signatures
Standard public-key encryption / hybrid encryption
Secure platform key storage
```

Recommended primitives should be selected based on platform support and reviewed before implementation.

Do not use:

```text
plain SHA as encryption
home-made encryption
home-made signatures
reused nonces with AEAD
static request nonces
long-lived QR credentials
private keys inside QR codes
secrets in QR codes
```

---

# 21. Recommended Protocol State Machine

```text
PAIR_REQUEST_CREATED
        │
        ▼
QR_DISPLAYED
        │
        ▼
APP_SCANNED_QR
        │
        ▼
DOMAIN_VERIFICATION
        │
        ├── FAIL ──► REJECTED
        │
        ▼
DOMAIN_VERIFIED
        │
        ▼
WEBRTC_ESTABLISHING
        │
        ▼
WEBRTC_ESTABLISHED
        │
        ▼
APP_PROOF_VERIFIED
        │
        ▼
IDENTITIES_EXCHANGED
        │
        ▼
PAIRING_ESTABLISHED
        │
        ▼
SECRET_TRANSFER
        │
        ▼
PAIRING_COMPLETE
```

For retrieval:

```text
SECRET_REQUEST_CREATED
        │
        ▼
QR_DISPLAYED
        │
        ▼
APP_SCANNED_QR
        │
        ▼
DOMAIN_VERIFICATION
        │
        ├── FAIL ──► REJECTED
        │
        ▼
DOMAIN_VERIFIED
        │
        ▼
DOMAIN_SECRET_MATCH
        │
        ├── FAIL ──► REJECTED
        │
        ▼
WEBRTC_SESSION
        │
        ▼
SECRET_DECRYPTED
        │
        ▼
SIGNED
        │
        ▼
ENCRYPTED_FOR_DOMAIN
        │
        ▼
WEBRTC_TRANSFER
        │
        ▼
WEB_SIGNATURE_VERIFIED
        │
        ▼
COMPLETE
```

---

# 22. Important Architectural Principle

The system deliberately uses different mechanisms for different purposes:

```text
QR
 │
 └── Human/device bootstrap

HTTPS domain verification
 │
 └── Domain authorization

request_id + nonce
 │
 └── Fresh, single-use transaction context

WebRTC
 │
 └── P2P transport

App private/public key
 │
 └── App identity

Domain private/public key
 │
 └── Domain identity

Proof of possession
 │
 └── Demonstrates control of App private key

Encryption
 │
 └── Confidentiality

Signature
 │
 └── Authenticity + integrity

Domain binding
 │
 └── Prevents cross-domain secret access
```

---

# 23. Implementation Guidance for Codex

Implement the system in layers.

## Phase 1

Implement:

- App key generation.
- Domain key generation/configuration.
- QR generation.
- QR parsing.
- `/verificar/{request_id}` endpoint.
- Request expiration and single-use consumption.
- Domain verification.
- WebRTC establishment.

## Phase 2

Implement:

- App identity.
- Domain identity.
- Proof of possession.
- Pairing state machine.
- Binding of WebRTC session to pairing request.

## Phase 3

Implement:

- Secret generation.
- Hybrid encryption.
- Local encrypted vault.
- Domain-bound secret records.

## Phase 4

Implement:

- Secret request QR.
- Domain re-verification.
- Domain/secret matching.
- Signed response.
- Encryption for domain.
- WebRTC response.

## Phase 5

Implement security tests.

---

# 24. Mandatory Security Test Cases

The implementation must include tests for:

```text
1. Valid initial pairing
2. Invalid domain
3. Invalid request ID
4. Expired request
5. Reused request ID
6. Nonce mismatch
7. Modified QR payload
8. Modified proof of possession
9. Wrong App public key
10. Wrong domain public key
11. Wrong domain requesting another domain's secret
12. Replay of old secret response
13. Replay of old request
14. WebRTC session/request mismatch
15. Modified ciphertext
16. Modified signature
17. Invalid signature
18. Decryption failure
19. App private key never transmitted
20. Domain private key never transmitted
21. Secret never transmitted in plaintext
22. Concurrent consumption of the same request
23. Expired secret request
24. Attempt to reuse a consumed request
25. Cross-session message injection
```

---

# 25. Definition of Done

The implementation is complete only when:

- A Web can generate a QR pairing request.
- The App can scan it.
- The App verifies the request directly against the domain.
- The domain returns its public identity.
- The request becomes single-use.
- WebRTC is established.
- The App proves possession of its private key.
- App and domain identities become associated.
- The Web can encrypt a secret for the App.
- The App can store the encrypted secret securely.
- A subsequent QR request can be independently verified.
- The App matches the verified domain against the stored domain identity.
- The App can sign and encrypt the requested secret for that domain.
- The Web can verify the App signature and decrypt the response.
- Replay, cross-domain, tampering, and invalid-identity tests pass.
- No private key or plaintext secret is transmitted during the protocol.

---

# 26. Open Implementation Decisions

These should be resolved during implementation without changing the core protocol:

1. Exact asymmetric algorithms supported by target platforms.
2. Exact AEAD algorithm.
3. Exact signature algorithm.
4. WebRTC signaling implementation.
5. STUN/TURN infrastructure.
6. Secure storage implementation for Android/iOS/desktop.
7. Canonical serialization format for signed payloads.
8. Exact request expiration period.
9. Exact QR payload encoding.
10. Whether the protocol uses JSON or CBOR on the WebRTC data channel.
11. Domain identity key rotation strategy.
12. App key backup/recovery policy.

These are implementation decisions; they must not weaken the core security properties described above.

---

# 27. Final Protocol Summary

```text
                         INITIAL PAIRING

 WEB
  │
  ├── request_id + nonce + domain
  │
  ▼
 QR
  │
  ▼
 APP
  │
  ├── HTTPS → domain/verificar/request_id
  │
  ▼
 DOMAIN
  │
  ├── verifies request
  ├── consumes request
  └── returns Domain Public Key
  │
  ▼
 APP
  │
  ├── domain verified
  ├── creates proof of possession
  │
  ▼
 ═══════════════ WebRTC ═══════════════
  │
  ├── App ID
  ├── App Public Key
  ├── Proof of Possession
  └── Domain Identity
  │
  ▼
 PAIRING ESTABLISHED
  │
  ▼
 WEB
  │
  ├── generates secret
  ├── encrypts for App
  │
  ═══════════════ WebRTC ═══════════════►
                                         APP
                                          │
                                          └── stores secret
                                              bound to domain


                         SECRET RETRIEVAL

 WEB
  │
  ├── request_id + nonce + domain
  ▼
 QR
  │
  ▼
 APP
  │
  ├── verifies domain again
  ├── matches domain identity
  ├── retrieves domain-bound secret
  ├── signs response with App Private Key
  ├── encrypts response with Domain Public Key
  │
  ═══════════════ WebRTC ═══════════════►
                                         WEB
                                          │
                                          ├── decrypts
                                          ├── verifies signature
                                          └── accepts secret
```

**Core principle:**

```text
The QR authorizes the transaction.
HTTPS verifies the domain.
WebRTC transports the P2P exchange.
Public/private keys establish persistent identities.
Proof of possession establishes App key control.
Encryption protects confidentiality.
Signatures establish authenticity and integrity.
Domain binding prevents one domain from accessing another
domain's secret.
Nonces + request IDs + expiration prevent replay.
```
