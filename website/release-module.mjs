// Shared pure helpers for the download catalogue and its verification checks.
export function downloadLabel(asset) {
  if (asset.platform === 'win') return asset.kind === 'portable' ? 'Windows portable' : 'Windows installer';
  if (asset.platform === 'mac') return `macOS ${asset.arch === 'arm64' ? 'Apple silicon' : 'Intel'}${asset.kind === 'archive' ? ' ZIP' : ''}`;
  return asset.name;
}
export function downloadUrl(asset, base) {
  const root = new URL('downloads/', base);
  const url = new URL(asset.path, base);
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname) || !/\.(exe|dmg|zip)$/i.test(url.pathname)) throw new Error('Invalid download URL');
  return url.href;
}
export function fileSize(size) {
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
