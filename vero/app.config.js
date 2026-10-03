// Dynamic additions on top of app.json (which stays the static source of truth).
//
// Invite links: `vero://join/<token>` always works (scheme in app.json). When
// EXPO_PUBLIC_INVITE_HOST is set at build time (e.g. `vero.example.com`), the
// app also claims https://<host>/join/* and /channels/* as iOS Universal Links
// and Android App Links. The host must serve /.well-known/apple-app-site-association
// and /.well-known/assetlinks.json (see README -> "Invite links").
module.exports = ({ config }) => {
  const host = (process.env.EXPO_PUBLIC_INVITE_HOST || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z0-9-]+(:\d+)?$/.test(host)) return config;
  const hostname = host.replace(/:\d+$/, '');

  return {
    ...config,
    ios: {
      ...config.ios,
      associatedDomains: [...((config.ios && config.ios.associatedDomains) || []), `applinks:${hostname}`],
    },
    android: {
      ...config.android,
      intentFilters: [
        ...((config.android && config.android.intentFilters) || []),
        {
          action: 'VIEW',
          autoVerify: true,
          data: [
            { scheme: 'https', host: hostname, pathPrefix: '/join/' },
            { scheme: 'https', host: hostname, pathPrefix: '/channels/' },
          ],
          category: ['BROWSABLE', 'DEFAULT'],
        },
      ],
    },
  };
};
