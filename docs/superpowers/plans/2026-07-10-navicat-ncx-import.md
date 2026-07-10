# Navicat NCX Connection Import Implementation Plan

> **For agentic workers:** Execute inline in this task. No commits are created unless the user explicitly requests one.

**Goal:** Add a safe, previewable one-click import for Navicat `.ncx` connection exports.

**Architecture:** A strict-but-tolerant parser normalizes NCX XML in the Electron main process. Preview data is retained in a sender-bound expiring session, and the store performs one atomic batch write after the user confirms selected indices.

**Tech Stack:** Electron IPC, Node.js, `sax`, existing HTML/CSS/ES modules, existing self-test harness.

## Global Constraints

- Preserve existing connection contracts and database behavior.
- Decrypt NCX V2 AES and V1 Blowfish passwords only in the main process, then persist them with Electron `safeStorage`.
- Never send plaintext database or SSH credentials to the renderer.
- Reject DTD/ENTITY and enforce documented resource limits.
- Keep final configuration authoritative in the main process.

---

### Task 1: NCX parser

**Files:** `src/main/navicatNcx.js`, `src/main/selftest.js`

- [ ] Add failing tests for common attributes, grouped connections, SSH, SQLite, UTF-16, unsupported types, malformed XML, and DTD rejection.
- [ ] Run `npm run selftest` and confirm the new assertions fail for the missing parser behavior.
- [ ] Implement `parseNcx`, `parseNcxBuffer`, and `targetLabel` with bounded strict XML parsing and tolerant field aliases.
- [ ] Run `npm run selftest` and confirm parser tests pass.

### Task 2: Atomic store import

**Files:** `src/main/store.js`, `src/main/selftest.js`

- [ ] Add failing tests for blank secrets, exact duplicate skipping, conflict renaming, and one-write batch behavior.
- [ ] Implement `importConnections(configs)` using the existing normalized record format and a single save operation.
- [ ] Run `npm run selftest` and confirm store import tests pass.

### Task 3: Main-process import session

**Files:** `src/main/ipc.js`, `src/main/preload.js`, `src/main/selftest.js`

- [ ] Add channel-contract checks for the dedicated chooser, preview, and import APIs.
- [ ] Implement a sender-bound ten-minute preview session with bounded session count.
- [ ] Add native confirmation for persisted SQLite and SSH key paths.
- [ ] Expose only the three narrow preload methods.

### Task 4: Renderer workflow

**Files:** `src/renderer/js/navicatImport.js`, `src/renderer/js/menubar.js`, `src/renderer/js/app.js`, `src/renderer/css/app.css`

- [ ] Add “导入 Navicat 连接…” to the file menu and action dispatcher.
- [ ] Build a preview modal with default selections, warnings, duplicate status, and a live import count.
- [ ] Refresh the connection tree and show a concise result toast after import.

### Task 5: Documentation and verification

**Files:** `README.md`, `package.json`, `package-lock.json`

- [ ] Document supported databases and automatic V1/V2 password import.
- [ ] Run syntax checks for all changed JavaScript files.
- [ ] Run `npm run verify` and require zero failures.
- [ ] Run the existing directory packaging command and report any environment-only limitation exactly.

### Task 6: Automatic NCX password decryption

**Files:** `src/main/navicatCrypto.js`, `src/main/navicatNcx.js`, `src/main/store.js`, `src/main/selftest.js`, `src/renderer/js/navicatImport.js`, `README.md`, `package.json`, `package-lock.json`

**Interfaces:**
- Produces: `decryptNavicatSecret(ciphertext): { plaintext, version }`, throwing for invalid or unsupported non-empty ciphertext.
- Consumes: NCX `Password`, `SSH_Password`, and `SSH_Passphrase` fields.

- [ ] Add failing self-tests using the published V1 ciphertext `0EA71F51DD37BFB60CCBA219BE3A` and V2 ciphertext `B75D320B6211468D63EB3B67C9E85933`, both expected to decrypt to `This is a test`.
- [ ] Run `npm run selftest` and confirm the new decryption assertions fail because `navicatCrypto.js` does not exist.
- [ ] Add the MIT-licensed Blowfish dependency and implement V1 block processing plus Node `crypto` AES-128-CBC V2 processing.
- [ ] Update NCX parsing to decrypt database and SSH secrets in the main process, report successful password imports without returning plaintext preview data, and skip connections whose non-empty secrets cannot be decrypted.
- [ ] Update batch persistence to encrypt imported plaintext using existing `encryptPassword`, and assert stored secrets round-trip while public records expose only `hasPassword` flags.
- [ ] Update UI and README wording to state that passwords are imported automatically.
- [ ] Run syntax checks, `npm run verify`, `git diff --check`, and unsigned directory packaging.
