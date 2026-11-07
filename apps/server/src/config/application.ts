import packageJson from '../../../../package.json' with { type: 'json' };

// The desktop bundler embeds this manifest value, so packaged apps need no source path.
export const APPLICATION_VERSION = packageJson.version;
