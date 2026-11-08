/** Pure configuration, independent of CI and of electron-builder's implementation. */
export function signingMode(target, env = {}) {
  if (target.platform === 'linux') return 'unsigned';
  const certificate = Boolean(env.CSC_LINK);
  if (target.platform === 'win32') {
    if (env.CSC_KEY_PASSWORD && !certificate) throw new Error('Windows certificate password has no certificate');
    return certificate ? 'authenticode' : 'unsigned';
  }
  const apple = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
  const anyApple = apple.some(key => Boolean(env[key]));
  if ((certificate || anyApple || env.CSC_KEY_PASSWORD) && (!certificate || !apple.every(key => Boolean(env[key])))) {
    throw new Error('macOS signing requires CSC_LINK and all three Apple notarization credentials; partial configuration is refused');
  }
  return certificate ? 'developer-id-notarized' : 'ad-hoc';
}
export function builderConfiguration(target, env = {}) {
  const signing = signingMode(target, env);
  const config = {
    appId: 'dev.owntake.desktop', productName: 'OwnTake', asar: true,
    directories: { output: 'release', buildResources: 'apps/desktop/dist' },
    files: ['apps/desktop/dist/**/*', 'apps/web/dist/**/*', 'package.json', '!node_modules/**/*'],
    npmRebuild: false, publish: null,
    artifactName: `owntake-${target.id}.\${ext}`,
  };
  const targets = target.formats.map(format => ({ target: format, arch: [target.arch] }));
  if (target.platform === 'darwin') {
    config.mac = {
      target: targets, icon: 'apps/desktop/dist/icon.png', category: 'public.app-category.video',
      hardenedRuntime: true, gatekeeperAssess: false, notarize: signing === 'developer-id-notarized',
      ...(signing === 'ad-hoc' ? { identity: '-' } : {}),
    };
    config.forceCodeSigning = signing === 'developer-id-notarized';
  } else if (target.platform === 'win32') {
    config.win = { target: targets, icon: 'apps/desktop/dist/icon.png' };
    config.nsis = { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, runAfterFinish: false, deleteAppDataOnUninstall: false };
    config.forceCodeSigning = signing === 'authenticode';
  } else {
    config.linux = { target: targets, icon: 'apps/desktop/dist/icon.png', category: 'AudioVideo', executableName: 'owntake' };
  }
  return config;
}
