const fs = require('fs');
const path = require('path');

const USER_DATA_FILES = [
  'connections.json',
  'groups.json',
  'history.json',
  'queries.json',
  'ai-config.json',
  'ssh-known-hosts.json',
];

// Electron safeStorage uses encryption metadata from Chromium's Local State.
// A connections.json containing safeStorage ciphertext is not portable without it.
const SAFE_STORAGE_STATE_FILE = 'Local State';

function migrateLegacyUserData(destination, legacyDirectories) {
  fs.mkdirSync(destination, { recursive: true });
  let credentialSource = null;
  for (const legacyDirectory of legacyDirectories) {
    if (!legacyDirectory || legacyDirectory === destination || !fs.existsSync(legacyDirectory)) continue;
    for (const file of USER_DATA_FILES) {
      const source = path.join(legacyDirectory, file);
      const target = path.join(destination, file);
      if (fs.existsSync(source) && !fs.existsSync(target)) {
        fs.copyFileSync(source, target);
        if (file === 'connections.json') credentialSource = legacyDirectory;
      }
    }
  }

  // Repair profiles created by the first DBPanda migration, which copied the
  // connection file but omitted its encryption state. Byte equality ensures we
  // never replace the key after the user has changed credentials in DBPanda.
  if (!credentialSource) {
    const currentConnections = path.join(destination, 'connections.json');
    if (fs.existsSync(currentConnections)) {
      const current = fs.readFileSync(currentConnections);
      credentialSource = legacyDirectories.find((legacyDirectory) => {
        if (!legacyDirectory || legacyDirectory === destination) return false;
        const legacyConnections = path.join(legacyDirectory, 'connections.json');
        const legacyState = path.join(legacyDirectory, SAFE_STORAGE_STATE_FILE);
        return fs.existsSync(legacyConnections) && fs.existsSync(legacyState)
          && current.equals(fs.readFileSync(legacyConnections));
      }) || null;
    }
  }

  // Keep the key state paired with the connection file that won precedence.
  // This runs before Electron initializes safeStorage in the renamed profile.
  if (credentialSource) {
    const source = path.join(credentialSource, SAFE_STORAGE_STATE_FILE);
    const target = path.join(destination, SAFE_STORAGE_STATE_FILE);
    if (fs.existsSync(source)) fs.copyFileSync(source, target);
  }
}

module.exports = { USER_DATA_FILES, SAFE_STORAGE_STATE_FILE, migrateLegacyUserData };
