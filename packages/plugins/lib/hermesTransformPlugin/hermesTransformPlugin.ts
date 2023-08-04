import fs, { type FileHandle } from 'node:fs/promises';
import type { OnLoadArgs, OnLoadResult } from 'esbuild';
import { CacheManager } from '@react-native-esbuild/core';
import { isFlow } from '../helpers';
import { logger } from '../shared';
import type { PluginCreator } from '../types';
import { transformWithBabel, transformWithSwc } from './transformer';

const NAME = 'hermes-transform-plugin';

export const createHermesTransformPlugin: PluginCreator<null> = (
  _config,
  context,
) => ({
  name: NAME,
  setup: (build): void => {
    const cache = new CacheManager();
    const cacheEnabled = context.bundlerConfig.dev;
    const {
      transform: {
        stripFlowPackageNames = [],
        fullyTransformPackageNames = [],
        customTransformRules = [],
      },
    } = context.config;
    const workingDirectory = process.cwd();

    const stripFlowPackageNamesRegExp = stripFlowPackageNames.length
      ? new RegExp(`node_modules/(${stripFlowPackageNames.join('|')})/`)
      : undefined;

    const fullyTransformPackagesRegExp = fullyTransformPackageNames.length
      ? new RegExp(`node_modules/(${fullyTransformPackageNames.join('|')})/`)
      : undefined;

    const getTransformedSourceFromCache = async (
      args: OnLoadArgs,
    ): Promise<{ contents: string; fromCache: boolean; hash?: string }> => {
      let fileHandle: FileHandle | null = null;
      let hash: string | undefined;

      try {
        fileHandle = await fs.open(args.path, 'r');

        if (cacheEnabled) {
          const { mtimeMs } = await fileHandle.stat();
          const memoryCacheKey = `${args.path}${
            build.initialOptions.platform ?? ''
          }`;
          const inMemoryCache = cache.readFromMemory(memoryCacheKey);
          const hashParam = [
            build.initialOptions.platform,
            context.config,
            args.path,
            mtimeMs,
          ] as const;

          // 1. find cache from memory
          if (inMemoryCache) {
            if (inMemoryCache.modifiedAt === mtimeMs) {
              // file is not modified, using cache data
              logger.debug(`in-memory cache hit: ${args.path}`);
              return { contents: inMemoryCache.data, fromCache: true };
            }

            // cache is not exist or file is modified(stale),
            // read original content (to be transformed)
            return {
              contents: await fileHandle.readFile({ encoding: 'utf-8' }),
              fromCache: false,
              hash: cache.getCacheHash(hashParam),
            };
          }

          hash = cache.getCacheHash(hashParam);
          const cachedSource = await cache.readFromFileSystem(hash);

          // 2. find cache from fils system
          if (cachedSource) {
            cache.writeToMemory(memoryCacheKey, {
              data: cachedSource,
              modifiedAt: mtimeMs,
            });
            return { contents: cachedSource, fromCache: true };
          }
        }

        // 3. if cache is not exist or cache is disabled, read original source code
        return {
          contents: await fileHandle.readFile({ encoding: 'utf-8' }),
          fromCache: false,
          hash,
        };
      } finally {
        await fileHandle?.close();
      }
    };

    const transformSource = async (
      args: OnLoadArgs,
      rawSource: string,
      hash?: string,
    ): Promise<string> => {
      if (typeof hash !== 'string') {
        throw new Error('hash is required for caching');
      }

      let source = rawSource;
      let fullyTransformed = false;

      if (fullyTransformPackagesRegExp?.test(args.path)) {
        source = await transformWithBabel(source, args, {
          // follow babelrc of react-native project's root (same as metro)
          babelrc: true,
        });
        fullyTransformed = true;
      }

      if (
        !fullyTransformed &&
        (isFlow(source, args.path) ||
          stripFlowPackageNamesRegExp?.test(args.path))
      ) {
        source = await transformWithBabel(source, args, {
          babelrc: false,
          plugins: [
            // babel plugins in metro preset
            // https://github.com/facebook/react-native/blob/main/packages/react-native-babel-preset/src/configs/main.js
            '@babel/plugin-syntax-flow',
            '@babel/plugin-transform-flow-strip-types',
          ],
        });
      }

      for await (const rule of customTransformRules) {
        if (rule.test(args.path, source)) {
          source = await transformWithBabel(source, args, {
            babelrc: false,
            plugins: rule.plugins,
          });
        }
      }

      // transform source target to es5
      source = await transformWithSwc(source, args);

      if (cacheEnabled) {
        await cache.writeToFileSystem(hash, source);
      }

      return source;
    };

    build.onLoad({ filter: /\.(?:[mc]js|[tj]sx?)$/ }, async (args) => {
      const { contents, fromCache, hash } = await getTransformedSourceFromCache(
        args,
      );
      const usingCache = fromCache && cacheEnabled;

      if (usingCache) {
        logger.debug(
          `(${NAME}) transform cache hit: ${args.path.replace(
            workingDirectory,
            '',
          )}`,
        );
      }

      return {
        contents: fromCache
          ? contents
          : await transformSource(args, contents, hash),
        loader: 'js',
      } as OnLoadResult;
    });
  },
});
