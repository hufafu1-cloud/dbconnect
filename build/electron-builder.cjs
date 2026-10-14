const { releaseVariant } = require('../package.json');
const { profiles } = require('../scripts/release-profile');
const profile = profiles[releaseVariant];
if (!profile) throw new Error('Prepare a release profile first');
module.exports = {
  extends: null,
  ...require('../package.json').build,
  directories: { output: 'release' },
  generateUpdatesFilesForAllChannels: false,
  publish: { provider: 'generic', url: 'https://github.com/hufafu1-cloud/dbconnect/releases/latest/download/', channel: profile.channel },
  win: { ...require('../package.json').build.win,
    artifactName: releaseVariant === 'win7-x64' ? 'DBPanda-Win7-x64-Setup.${ext}' : 'DBPanda-Setup.${ext}' },
  linux: {
    target: ['AppImage', 'deb'],
    artifactName: 'DBPanda-Linux-${arch}.${ext}',
    icon: 'assets/icon.png',
    category: 'Development',
    maintainer: 'DBPanda <hufafu1-cloud@users.noreply.github.com>',
    executableName: 'dbpanda',
  },
  mac: {
    target: ['dmg', 'zip'],
    artifactName: 'DBPanda-Mac-${arch}.${ext}',
    icon: 'assets/icon.png',
    category: 'public.app-category.developer-tools',
  },
};
