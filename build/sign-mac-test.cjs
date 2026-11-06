// Ad-hoc signing for test distributions; this does not provide Gatekeeper trust.
const { signAsync } = require('@electron/osx-sign');
const { execFileSync } = require('child_process');
exports.sign = async function (options) {
  await signAsync({ ...options, identity: '-', identityValidation: false });
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', options.app], { stdio: 'inherit' });
};
