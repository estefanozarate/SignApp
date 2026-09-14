# Cómo funciona Sello — el código real

> Este documento describe lo que el código de este repositorio hace **de
> verdad**, no lo que pide `diseno_app.md`. Hay diferencias entre ambos —
> la más importante es que aquí no hay WebRTC: todo el transporte es HTTP
> normal (ver `server/README.md`, sección "Por qué esto es HTTP y no
> WebRTC"). Este documento no discute esas diferencias; solo explica cómo
> viaja y cómo se guarda el secreto en la implementación actual.

## Piezas

| Pieza | Archivo |
|---|---|
| Dominio de referencia | `server/servidor.mjs` |
| Demo web | `web/index.html` |
| Protocolo del lado app (JS) | `src/services/peticion.ts`, `src/services/boveda.ts` |
| Keystore nativo (Kotlin) | `android/app/src/main/java/io/sello/app/signing/SigningModule.kt` |

Tres claves viven en el Keystore de Android, cada una con su propio nivel
de protección:

```mermaid
flowchart TD
    subgraph KS["AndroidKeyStore (por dispositivo)"]
        EC["sello.identidad.v1<br/>EC P-256 · firmar<br/>🔒 biometría POR OPERACIÓN"]
        RSA["sello.cifrado.v1<br/>RSA-2048 OAEP · descifrar<br/>🔓 SIN autenticación"]
        AES["sello.boveda.v1<br/>AES-256-GCM · bóveda local<br/>🔒 biometría por VENTANA (10s)"]
    end
    EC -->|firma la prueba de posesión<br/>y la respuesta del §14| USO1[Identidad y autenticidad]
    RSA -->|abre el sobre que<br/>manda el dominio| USO2[Recibir el secreto entrante]
    AES -->|cifra/descifra lo que<br/>se guarda en disco| USO3[Bóveda local]
```

La clave RSA es la única que **no** pide biometría al usarse — es una
decisión deliberada del código (un Keymaster concreto no completaba el
descifrado RSA-OAEP con clave ligada a autenticación); lo que autoriza
recibir un secreto nuevo es la firma de la prueba de posesión, hecha un
instante antes con la clave EC, que sí exige biometría.

---

## Flujo 1 — Cómo viaja el secreto

Tiene dos direcciones independientes: **el dominio lo entrega** al
emparejar, y **la app lo devuelve** cuando el dominio lo vuelve a pedir.

### 1a. Entrega inicial (emparejamiento, `purpose = PAIR`)

```mermaid
sequenceDiagram
    participant Web
    participant Dominio as Dominio (servidor.mjs)
    participant App
    participant KS as Keystore (Kotlin)

    Web->>Dominio: POST /peticion {purpose: PAIR}
    Dominio-->>Web: {request_id, nonce, qr}
    Web->>Web: Muestra el QR

    App->>App: Escanea el QR, lee {domain, request_id, nonce}
    App->>Dominio: GET /verificar/{request_id}<br/>(URL construida por la app, no la del QR)
    Dominio->>Dominio: Consume la petición (atómico)
    Dominio-->>App: {domain_id, domain_public_key, ...}

    App->>KS: firmar(domain+request_id+nonce+"PAIR")
    KS->>KS: BiometricPrompt (clave EC, por operación)
    KS-->>App: proof_of_possession

    App->>Dominio: POST /respuesta/{id}<br/>{type: APP_IDENTITY, app_id,<br/>app_public_key, proof_of_possession,<br/>app_encryption_key}
    Dominio->>Dominio: Valida la prueba de posesión
    Dominio->>Dominio: Registra la app (SQLite)
    Dominio->>Dominio: Genera secreto aleatorio (CSPRNG)
    Dominio->>Dominio: AES-256-GCM(secreto) +<br/>RSA-OAEP(clave AES, app_encryption_key)
    Dominio-->>App: {ok, secret: sobre_cifrado}

    App->>KS: abrirSobre(sobre_cifrado)
    KS->>KS: RSA privada desenvuelve la clave AES<br/>(SIN biometría — ver nota arriba)
    KS->>KS: AES-GCM descifra el secreto
    KS-->>App: secreto en claro

    Note over App,KS: sigue en el Flujo 2 — guardar en la bóveda
```

Puntos que vale la pena notar:

- La app **nunca** confía en una URL de verificación que venga en el QR:
  la construye ella misma a partir del campo `domain` (`baseDe()` en
  `peticion.ts`).
- El secreto viaja cifrado en todo momento; el navegador nunca lo ve, ni
  siquiera de paso — la Web solo recibe `secret_fingerprint` (huella
  SHA-256 truncada) como confirmación visual.
- La clave AES de sesión (para el sobre) es de un solo uso, generada al
  vuelo por el dominio; nunca se reutiliza entre peticiones.

### 1b. Devolución del secreto (recuperación, `purpose = SECRET_REQUEST`)

```mermaid
sequenceDiagram
    participant Web
    participant Dominio as Dominio (servidor.mjs)
    participant App
    participant KS as Keystore (Kotlin)
    participant Boveda as Bóveda local (AsyncStorage)

    Web->>Dominio: POST /peticion {purpose: SECRET_REQUEST}
    Dominio-->>Web: {request_id, nonce, qr}
    Web->>Web: Muestra el QR

    App->>App: Escanea el QR
    App->>Dominio: GET /verificar/{request_id}
    Dominio-->>App: {domain_id, domain_public_key, ...}

    App->>Boveda: paraDominio(domain_id, domain_public_key)
    alt no coincide domain_id o domain_public_key
        Boveda-->>App: undefined
        App->>App: E_SIN_SECRETO — DENY, no se libera nada
    else coincide
        Boveda-->>App: secreto guardado (sobre cifrado)
    end

    App->>KS: autenticar() — desbloquea ventana de 10s
    KS->>KS: BiometricPrompt (clave AES bóveda)
    App->>KS: descifrarDeBoveda(sobre)
    KS-->>App: secreto en claro

    App->>App: construye {version, request_id, nonce,<br/>domain_id, app_id, secret}
    App->>KS: firmar(canónico de la respuesta)
    KS->>KS: BiometricPrompt (clave EC, por operación)
    KS-->>App: signature

    App->>App: claro = {...respuesta, signature}
    App->>KS: cerrarSobre(domain_public_key, claro)
    KS->>KS: AES-256-GCM(claro) +<br/>RSA-OAEP(clave AES, domain_public_key)
    KS-->>App: sobre cifrado para el dominio

    App->>Dominio: POST /respuesta/{id}<br/>{type: SECRET_RESPONSE, envelope}
    Dominio->>Dominio: Abre el sobre con su clave privada
    Dominio->>Dominio: Verifica request_id/nonce/domain_id DENTRO del sobre
    Dominio->>Dominio: Busca la app registrada por app_id
    Dominio->>Dominio: Verifica la firma con su clave pública registrada
    Dominio->>Dominio: Compara contra el secreto que él mismo entregó<br/>(timingSafeEqual)
    Dominio-->>App: {ok, signature_valid, matches, secret_fingerprint}

    Web->>Dominio: GET /respuesta/{id} (long-poll, hasta 25s)
    Dominio-->>Web: veredicto (signature_valid, matches, fingerprint)<br/>— NUNCA el secreto en claro
```

Puntos que vale la pena notar:

- El "domain match" (§13) se comprueba **dos veces**: por la app antes de
  leer la bóveda (`paraDominio`), y de forma implícita por el dominio al
  recibir la respuesta (compara `claro.domain_id` contra su propio
  `DOMAIN_ID`).
- El contexto (`request_id`, `nonce`, `domain_id`) va **firmado dentro
  del sobre cifrado**, no solo como parámetros de la URL — así el dominio
  no puede confiar en nada que no esté cubierto por la firma.
- La Web nunca recibe el secreto en claro, ni en el emparejamiento ni en
  la devolución: solo huellas (`secret_fingerprint`) y veredictos
  booleanos.

---

## Flujo 2 — Cómo se guarda el secreto (bóveda local)

El secreto que sale de `abrirSobre()` (Flujo 1a) **no se guarda tal
cual**: se vuelve a cifrar, esta vez con la clave AES de la bóveda —
distinta de la RSA que lo recibió — antes de tocar el disco.

```mermaid
sequenceDiagram
    participant UI as Pantalla (Aprobacion.tsx)
    participant JS as boveda.ts / Signing.ts
    participant KS as Keystore (Kotlin)
    participant Disco as AsyncStorage

    Note over UI,Disco: Guardar (tras un PAIR exitoso)
    UI->>JS: Signing.autenticar("Guardar secreto", dominio)
    JS->>KS: BiometricPrompt (sin CryptoObject)
    KS-->>JS: ventana de 10s abierta

    UI->>JS: Signing.cifrarEnBoveda(secretoClaroB64)
    JS->>KS: AES-256-GCM.encrypt() con sello.boveda.v1
    KS-->>JS: {ivB64, cifradoB64, tagB64}

    JS->>Disco: guardar({domain_id, domain, domain_public_key,<br/>sobre: {iv, cifrado, tag}, recibidoEn})
    Note right of Disco: domain_id y domain_public_key quedan EN CLARO<br/>a propósito — el §13 los necesita comparar<br/>sin pedir biometría solo para "mirar si hay algo guardado"

    Note over UI,Disco: Leer (para devolver el secreto, Flujo 1b)
    JS->>Disco: paraDominio(domain_id, domain_public_key)
    Disco-->>JS: registro (o undefined si no coincide)
    JS->>KS: autenticar() si la ventana ya expiró
    JS->>KS: Signing.descifrarDeBoveda(iv, cifrado, tag)
    KS->>KS: AES-256-GCM.decrypt() con sello.boveda.v1
    KS-->>JS: secreto en claro
```

Qué queda en claro y qué no, en el registro guardado
(`SecretoGuardado` en `boveda.ts`):

| Campo | ¿En claro? | Por qué |
|---|---|---|
| `domain_id` | Sí | El §13 necesita compararlo sin pedir autenticación solo para saber si hay algo guardado |
| `domain` (nombre) | Sí | Solo se usa para mostrarlo en pantalla, nunca para decidir nada |
| `domain_public_key` | Sí | Misma razón que `domain_id` — comparación de identidad, no un secreto |
| `sobre` (el secreto) | **No** | Cifrado con AES-256-GCM del Keystore; leerlo exige `autenticar()` |

Reglas de sustitución y borrado:

- Un secreto nuevo para la **misma** identidad de dominio (`domain_id`)
  **sustituye** al anterior — `boveda.guardar()` filtra los previos con
  ese `domain_id` antes de insertar el nuevo. No quedan dos secretos
  "vigentes" para el mismo dominio.
- `olvidarDominio(domainId)` borra solo el registro de ese dominio;
  `vaciarBoveda()` borra todo `AsyncStorage` bajo la clave
  `sello.boveda`.
- `borrarIdentidad()` (Kotlin) borra las tres claves del Keystore —
  irreversible, no hay copia en ningún lado.
