# DBPanda Rebrand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the Datavia desktop database product to DBPanda and ship the approved panda-on-database logo in every Windows brand surface.

**Architecture:** Preserve the generated artwork as an immutable source, derive a transparent full brand lockup plus a square app-icon crop, and package nine native Windows icon sizes. Centralize visible product identity checks in a Node regression script and migrate existing `%APPDATA%/Datavia` data into `%APPDATA%/DBPanda` without overwriting newer files.

**Tech Stack:** Electron 37, Node.js, electron-builder 25, PNG/ICO asset generator, PowerShell release verification.

---

### Task 1: Approved DBPanda Artwork

**Files:**
- Create: `assets/dbpanda-logo-source.png`
- Create: `assets/dbpanda-logo.png`
- Modify: `assets/logo-original.png`
- Modify: `assets/icon.png`
- Modify: `assets/icon.ico`
- Modify: `scripts/gen-icon.js`
- Modify: `scripts/test-brand-assets.js`

- [ ] Write failing assertions for the DBPanda source, transparent brand lockup, and nine-size ICO.
- [ ] Run `node scripts/test-brand-assets.js` and confirm failure on the old owl source.
- [ ] Remove the flat magenta background from the approved image and save the transparent lockup.
- [ ] Update the generator to crop only the panda-plus-database emblem for app icons.
- [ ] Run `npm run icon` and the asset test until both pass.

### Task 2: Product Identity and Data Migration

**Files:**
- Create: `scripts/test-product-brand.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/main/main.js`
- Modify: `src/main/ipc.js`
- Modify: `src/main/exporter.js`
- Modify: `src/main/sync.js`
- Modify: `src/main/transfer.js`
- Modify: `src/main/fileAccess.js`
- Modify: `src/main/db/clickhouse.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/js/menubar.js`
- Modify: `src/renderer/js/app.js`
- Modify: `src/renderer/js/aiPanel.js`
- Modify: `README.md`
- Modify: `LICENSE`

- [ ] Write a failing brand scan requiring `DBPanda` in user-visible surfaces and forbidding `Datavia` there.
- [ ] Run the scan and confirm it reports current Datavia references.
- [ ] Change package identity, window/UI copy, exported comments, application client name, docs, and shortcuts to DBPanda.
- [ ] Extend startup migration to copy DBConnect first, then Datavia, into DBPanda while preserving existing destination files.
- [ ] Run the brand scan and Electron selftests.

### Task 3: Windows Release

**Files:**
- Modify: `scripts/verify-windows-release.ps1`
- Verify: `release/DBPanda-Setup-2.5.2.exe`
- Verify: `release/DBPanda-Setup-2.5.2.zip`

- [ ] Update release checks to expect `DBPanda.exe` and DBPanda artifact names.
- [ ] Run `npm run dist`.
- [ ] Run asset checks, brand scan, `npm run verify`, and `npm run release:verify`.
- [ ] Record artifact sizes and SHA-256 hashes.

