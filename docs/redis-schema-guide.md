# InkChat - Upstash Redis Schema & REST Command Manual

This document details the database schema architecture and provides exact raw **cURL** instructions for administrating the serverless **Upstash Redis** database powering the InkChat device validation proxy.

---

## 1. Keyspace & Values

To guarantee high throughput and sub-5ms lookups, InkChat utilizes a single, lightweight keyspace format with no expiration (TTL = `-1`):

### Keyspace format: `device:[TOKEN]`
*   **Key Type:** `String`
*   **Key Lifetime (TTL):** Permanent. Account bindings and restrictions do not expire automatically and require administrative commands to modify.
*   **Valid String Values:**
    1.  `BANNED` - The device is flagged. Handshakes instantly halt execution.
    2.  `[USER_ID]` (e.g. `user_72948`) - Maps this physical hardware instance strictly to the specified user identity (enforcing the 1-account-per-device limit).

---

## 2. Upstash REST API Administration Reference 

The Upstash serverless REST API accepts HTTP `POST` commands structured as raw JSON arrays. You must supply your unique Upstash endpoint and REST Token to execute administrative operations.

### Configuration Template
*   **REST URL Base:** `https://[your-upstash-region].upstash.io`
*   **REST Token:** `[YOUR_UPSTASH_REST_TOKEN]`

---

## 3. Administrative cURL Command Matrix

Use the following raw shell instructions to manage hardware nodes.

### 1. Look up a Device Signature Status
Retrieves the mapping payload associated with a specific stateless signature key.

```bash
curl -X POST "https://[your-upstash-region].upstash.io" \
     -H "Authorization: Bearer [YOUR_UPSTASH_REST_TOKEN]" \
     -H "Content-Type: application/json" \
     -d '["GET", "device:c2NyZWVuOjgwMHg2MDB8Zm9udDoxMjEuNHxzaWxpY29uOjEwfGVuZ2luZTphdWRpbzozYTdiNmY5"]'
```

#### Expected Output Structures:
*   **Device is Unmapped (Clean/Fresh):**
    ```json
    {"result": null}
    ```
*   **Device is Active & Mapped:**
    ```json
    {"result": "user_72948"}
    ```
*   **Device is Blocked (Restricted):**
    ```json
    {"result": "BANNED"}
    ```

---

### 2. Manually Map a Device to a User
Binds a hardware signature directly to an identity string.
```bash
curl -X POST "https://[your-upstash-region].upstash.io" \
     -H "Authorization: Bearer [YOUR_UPSTASH_REST_TOKEN]" \
     -H "Content-Type: application/json" \
     -d '["SET", "device:c2NyZWVuOjgwMHg2MDB8Zm9udDoxMjEuNHxzaWxpY29uOjEwfGVuZ2luZTphdWRpbzozYTdiNmY5", "user_72948"]'
```

*   **Expected Success Output:**
    ```json
    {"result": "OK"}
    ```

---

### 3. Hard-Ban a Device Token (Permanent Lockout)
Applies a restrictive ban overwrite to block access from the physical hardware instance.
```bash
curl -X POST "https://[your-upstash-region].upstash.io" \
     -H "Authorization: Bearer [YOUR_UPSTASH_REST_TOKEN]" \
     -H "Content-Type: application/json" \
     -d '["SET", "device:c2NyZWVuOjgwMHg2MDB8Zm9udDoxMjEuNHxzaWxpY29uOjEwfGVuZ2luZTphdWRpbzozYTdiNmY5", "BANNED"]'
```

*   **Expected Success Output:**
    ```json
    {"result": "OK"}
    ```

---

### 4. Lift a Ban or Un-link an Account (Delete Key)
Removes the mapping from the database, restoring the device terminal to a clean slate.
```bash
curl -X POST "https://[your-upstash-region].upstash.io" \
     -H "Authorization: Bearer [YOUR_UPSTASH_REST_TOKEN]" \
     -H "Content-Type: application/json" \
     -d '["DEL", "device:c2NyZWVuOjgwMHg2MDB8Zm9udDoxMjEuNHxzaWxpY29uOjEwfGVuZ2luZTphdWRpbzozYTdiNmY5"]'
```

*   **Expected Output on Success:**
    ```json
    {"result": 1}
    ```
    *(Returns `1` if the mapping key was successfully found and removed, `0` if it did not exist).*
