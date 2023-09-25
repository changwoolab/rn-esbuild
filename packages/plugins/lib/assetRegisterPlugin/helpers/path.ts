import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { OnLoadArgs } from 'esbuild';
import { imageSize } from 'image-size';
import md5 from 'md5';
import type { BundlerSupportPlatform } from '@react-native-esbuild/config';
import { ASSET_PATH, SUPPORT_PLATFORMS } from '@react-native-esbuild/config';
import type { PluginContext } from '@react-native-esbuild/core';
import type { Asset, AssetScale, SuffixPathResult } from '../../types';

const PLATFORM_SUFFIX_PATTERN = SUPPORT_PLATFORMS.map(
  (platform) => `.${platform}`,
).join('|');

const imageSizeOf = promisify(imageSize);

export function addSuffix(
  basename: string,
  extension: string,
  options?: {
    platform?: BundlerSupportPlatform | null;
    scale?: string | number;
  },
): string {
  return stripSuffix(basename, extension)
    .concat(options?.scale ? `@${options.scale}x` : '')
    .concat(options?.platform ? `.${options.platform}${extension}` : extension);
}

export function stripSuffix(basename: string, extension: string): string {
  return basename.replace(
    new RegExp(`(@(\\d+)x)?(${PLATFORM_SUFFIX_PATTERN})?${extension}`),
    '',
  );
}

/**
 * add suffix to asset path
 *
 * ```js
 * // assetPath input
 * '/path/to/assets/image.png'
 *
 * // `platform` suffixed
 * '/path/to/assets/image.android.png'
 *
 * // `scale` suffixed
 * '/path/to/assets/image@1x.png'
 *
 * // both `platform` and `scale` suffixed
 * '/path/to/assets/image@1x.android.png'
 * ```
 */
export function getSuffixedPath(
  assetPath: string,
  options?: {
    scale?: AssetScale;
    platform?: BundlerSupportPlatform | null;
  },
): SuffixPathResult {
  // if `scale` present, append scale suffix to path
  // assetPath: '/path/to/assets/image.png'
  // result:
  //   '/path/to/assets/image.png'
  //   '/path/to/assets/image.{platform}.png'
  //   '/path/to/assets/image@{scale}x.png'
  //   '/path/to/assets/image@{scale}x.{platform}.png'
  const extension = path.extname(assetPath);
  const dirname = path.dirname(assetPath);

  // strip exist suffixes and add new options based suffixes
  const strippedBasename = stripSuffix(path.basename(assetPath), extension);
  const suffixedBasename = addSuffix(strippedBasename, extension, options);

  return {
    dirname,
    basename: strippedBasename,
    extension,
    path: `${dirname}/${suffixedBasename}`,
    platform: options?.platform ?? null,
  };
}

export function getDevServerBasePath(asset: Asset): string {
  const basePath = asset.httpServerLocation;
  return basePath.at(0) === '/' ? basePath.substring(1) : basePath;
}

function assertSuffixPathResult(
  data: OnLoadArgs['pluginData'],
): asserts data is SuffixPathResult {
  if (
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- esbuild type
    !(typeof data.basename === 'string' && typeof data.extension === 'string')
  ) {
    throw new Error('invalid pluginData');
  }
}

export async function resolveScaledAssets(
  context: PluginContext,
  args: OnLoadArgs,
): Promise<Asset> {
  assertSuffixPathResult(args.pluginData);

  const { basename, extension, platform } = args.pluginData;
  const relativePath = path.relative(context.root, args.path);
  const dirname = path.dirname(args.path);
  const filesInDir = await fs.readdir(dirname);
  const stripedBasename = stripSuffix(basename, extension);
  const assetRegExp = new RegExp(
    `${stripedBasename}(@(\\d+)x)?${
      platform ? `.${platform}${extension}` : extension
    }$`,
  );
  const scaledAssets: Partial<Record<AssetScale, string>> = {};

  for (const file of filesInDir) {
    const match = assetRegExp.exec(file);
    if (match) {
      const [, , scale = 1] = match;
      scaledAssets[scale] = file;
    }
  }

  if (!(Object.keys(scaledAssets).length && scaledAssets[1])) {
    throw new Error(`cannot resolve base asset of ${args.path}`);
  }

  const dimensions = await imageSizeOf(args.path);
  const imageData = await fs.readFile(args.path);

  return {
    path: args.path,
    basename: stripedBasename,
    name: stripedBasename.replace(extension, ''),
    extension,
    type: extension.substring(1),
    // eslint-disable-next-line @typescript-eslint/require-array-sort-compare -- allow using default compare function
    scales: Object.keys(scaledAssets).map(parseFloat).sort(),
    httpServerLocation: path.join(ASSET_PATH, path.dirname(relativePath)),
    hash: md5(imageData),
    dimensions: {
      width: dimensions?.width ?? 0,
      height: dimensions?.height ?? 0,
    },
    platform,
  };
}

export async function resolveAssetPath(
  asset: Asset,
  targetScale: number,
): Promise<string> {
  const suffixedPath = getSuffixedPath(asset.path, {
    scale: targetScale as AssetScale,
    platform: asset.platform,
  }).path;

  // when scale is 1, filename can be suffixed(platform, scale) or plain(`image.png`)
  // 1. resolve plain asset first(`image.png`)
  // 2. if file is not exist, resolve suffixed path
  if (targetScale === 1) {
    const result = await fs
      .stat(asset.path)
      .then(() => asset.path)
      .catch(() => fs.stat(suffixedPath).then(() => suffixedPath));

    return result;
  }

  return suffixedPath;
}