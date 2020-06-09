import { CSB_PKG_PROTOCOL } from '@codesandbox/common/es/utils/ci';
import * as pathUtils from '@codesandbox/common/es/utils/path';
import resolve from 'browser-resolve';
import DependencyNotFoundError from 'sandbox-hooks/errors/dependency-not-found-error';
import delay from 'sandbox/utils/delay';

import Manager from '../manager';
import TranspiledModule from '../transpiled-module';
import { Module } from '../types/module';
import getDependencyName from '../utils/get-dependency-name';
import { packageFilter } from '../utils/resolve-utils';

type Meta = {
  [path: string]: any;
};
type Metas = {
  [dependencyAndVersion: string]: Meta;
};

type Packages = {
  [path: string]: Promise<Module>;
};

type MetaFiles = Array<{
  path: string;
  type: 'file' | 'directory';
  files?: MetaFiles;
}>;

const metas: Metas = {};
export let combinedMetas: Meta = {}; // eslint-disable-line
const normalizedMetas: { [key: string]: Meta } = {};
const packages: Packages = {};

function normalize(files: MetaFiles, fileObject: Meta = {}, rootPath: string) {
  for (let i = 0; i < files.length; i += 1) {
    if (files[i].type === 'file') {
      const absolutePath = rootPath + files[i].path;
      fileObject[absolutePath] = true; // eslint-disable-line no-param-reassign
    }

    if (files[i].files) {
      normalize(files[i].files, fileObject, rootPath);
    }
  }

  return fileObject;
}

function normalizeJSDelivr(files: any, fileObject: Meta = {}, rootPath) {
  for (let i = 0; i < files.length; i += 1) {
    const absolutePath = pathUtils.join(rootPath, files[i].name);
    fileObject[absolutePath] = true; // eslint-disable-line no-param-reassign
  }

  return fileObject;
}

/**
 * Converts urls like "https://github.com/user/repo.git" to "user/repo".
 */
const convertGitHubURLToVersion = (version: string) => {
  const result = version.match(/https:\/\/github\.com\/(.*)$/);
  if (result && result[1]) {
    const repo = result[1];
    return repo.replace(/\.git$/, '');
  }

  return version;
};

const urlProtocols = {
  csbGH: {
    file: async (name: string, version: string, path: string) =>
      `${version.replace(/\/_pkg.tgz$/, '')}${path}`,
    meta: async (name: string, version: string) =>
      `${version.replace(/\/\.pkg.tgz$/, '')}/_csb-meta.json`,
    normalizeMeta: normalize,
  },
  unpkg: {
    file: async (name: string, version: string, path: string) =>
      `https://unpkg.com/${name}@${version}${path}`,
    meta: async (name: string, version: string) =>
      `https://unpkg.com/${name}@${version}/?meta`,
    normalizeMeta: normalize,
  },
  jsDelivrNPM: {
    file: async (name: string, version: string, path: string) =>
      `https://cdn.jsdelivr.net/npm/${name}@${version}${path}`,
    meta: async (name: string, version: string) => {
      // if it's a tag it won't work, so we fetch latest version otherwise
      const latestVersion = /^\d/.test(version)
        ? version
        : JSON.parse(
            (await downloadDependency(name, version, '/package.json')).code
          ).version;

      return `https://data.jsdelivr.com/v1/package/npm/${name}@${latestVersion}/flat`;
    },
    normalizeMeta: normalizeJSDelivr,
  },
  jsDelivrGH: {
    file: async (name: string, version: string, path: string) =>
      `https://cdn.jsdelivr.net/gh/${convertGitHubURLToVersion(
        version
      )}${path}`,
    meta: async (name: string, version: string) => {
      // First get latest sha from GitHub API
      const sha = await fetch(
        `https://api.github.com/repos/${convertGitHubURLToVersion(
          version
        )}/commits/master`
      )
        .then(x => x.json())
        .then(x => x.sha);

      return `https://data.jsdelivr.com/v1/package/gh/${convertGitHubURLToVersion(
        version
      )}@${sha}/flat`;
    },
    normalizeMeta: normalizeJSDelivr,
  },
};

async function fetchWithRetries(url: string, retries = 6): Promise<Response> {
  const doFetch = () =>
    window.fetch(url).then(x => {
      if (x.ok) {
        return x;
      }

      throw new Error(`Could not fetch ${url}`);
    });

  let lastTryTime = 0;
  for (let i = 0; i < retries; i++) {
    if (Date.now() - lastTryTime < 3000) {
      // Ensure that we at least wait 3s before retrying a request to prevent rate limits
      // eslint-disable-next-line
      await delay(3000 - (Date.now() - lastTryTime));
    }
    try {
      lastTryTime = Date.now();
      // eslint-disable-next-line
      return await doFetch();
    } catch (e) {
      console.error(e);
      if (i === retries - 1) {
        throw e;
      }
    }
  }

  throw new Error('Could not fetch');
}

export function setCombinedMetas(givenCombinedMetas: Meta) {
  combinedMetas = givenCombinedMetas;
}

const getFetchProtocol = (depVersion: string, useFallback = false) => {
  const isDraftProtocol = CSB_PKG_PROTOCOL.test(depVersion);

  if (isDraftProtocol) {
    return urlProtocols.csbGH;
  }

  const isGitHub = /\//.test(depVersion);

  if (isGitHub) {
    return urlProtocols.jsDelivrGH;
  }

  return useFallback ? urlProtocols.unpkg : urlProtocols.jsDelivrNPM;
};

// Strips the version of a path, eg. test/1.3.0 -> test
const ALIAS_REGEX = /\/\d*\.\d*\.\d*.*?(\/|$)/;

/*
 * Resolve name and version from npm aliases
 * e.g. "my-react": "npm:react@16.0.0
 */
const resolveNPMAlias = (name: string, version: string): string[] => {
  const IS_ALIAS = /^npm:/;

  if (!version.match(IS_ALIAS)) {
    return [name, version];
  }

  const parts = version.match(/^npm:(.+)@(.+)/);
  return [parts[1], parts[2]];
};

async function getMeta(
  name: string,
  packageJSONPath: string | null,
  version: string,
  useFallback = false
) {
  const [depName, depVersion] = resolveNPMAlias(name, version);
  const nameWithoutAlias = depName.replace(ALIAS_REGEX, '');
  const id = `${packageJSONPath || depName}@${depVersion}`;
  if (metas[id]) {
    return metas[id];
  }

  const protocol = getFetchProtocol(depVersion, useFallback);

  metas[id] = protocol
    .meta(nameWithoutAlias, depVersion)
    .then(fetchWithRetries)
    .then(x => x.json())
    .catch(e => {
      delete metas[id];

      throw e;
    });

  return metas[id];
}

export async function downloadDependency(
  name: string,
  version: string,
  path: string
): Promise<Module> {
  const [depName, depVersion] = resolveNPMAlias(name, version);
  const id = depName + depVersion + path;
  if (packages[id]) {
    return packages[id];
  }

  const relativePath = path
    .replace(
      new RegExp(
        `.*${pathUtils.join('/node_modules', depName)}`.replace('/', '\\/')
      ),
      ''
    )
    .replace(/#/g, '%23');

  const nameWithoutAlias = depName.replace(ALIAS_REGEX, '');
  const protocol = getFetchProtocol(depVersion);

  packages[id] = protocol
    .file(nameWithoutAlias, depVersion, relativePath)
    .then(fetchWithRetries)
    .then(x => x.text())
    .catch(async () => {
      const fallbackProtocol = getFetchProtocol(depVersion, true);
      const fallbackUrl = await fallbackProtocol.file(
        nameWithoutAlias,
        depVersion,
        relativePath
      );

      return fetchWithRetries(fallbackUrl).then(x => x.text());
    })
    .then(x => ({
      path,
      code: x,
      downloaded: true,
    }));

  return packages[id];
}

function resolvePath(
  path: string,
  currentTModule: TranspiledModule,
  manager: Manager,
  defaultExtensions: Array<string> = ['js', 'jsx', 'json', 'mjs'],
  meta = {}
): Promise<string> {
  const currentPath = currentTModule.module.path;

  const isFile = (p: string, c?: any, cb?: any): any => {
    const callback = cb || c;

    const result = Boolean(manager.transpiledModules[p]) || Boolean(meta[p]);
    if (!callback) {
      return result;
    }

    return callback(null, result);
  };

  return new Promise((res, reject) => {
    resolve(
      path,
      {
        filename: currentPath,
        extensions: defaultExtensions.map(ext => '.' + ext),
        packageFilter: packageFilter(isFile),
        moduleDirectory: [
          'node_modules',
          manager.envVariables.NODE_PATH,
        ].filter(Boolean),
        isFile,
        readFile: async (p, c, cb) => {
          const callback = cb || c;

          try {
            const tModule = manager.resolveTranspiledModule(p, '/');
            tModule.initiators.add(currentTModule);
            currentTModule.dependencies.add(tModule);
            return callback(null, tModule.module.code);
          } catch (e) {
            const depPath = p.replace(/.*\/node_modules\//, '');
            const depName = getDependencyName(depPath);

            // To prevent infinite loops we keep track of which dependencies have been requested before.
            if (!manager.transpiledModules[p] && !meta[p]) {
              const err = new Error('Could not find ' + p);
              // @ts-ignore
              err.code = 'ENOENT';

              return callback(err);
            }

            // eslint-disable-next-line
            const subDepVersionVersionInfo = await getDependencyVersion(
              currentTModule,
              manager,
              defaultExtensions,
              depName
            );

            if (subDepVersionVersionInfo) {
              const { version: subDepVersion } = subDepVersionVersionInfo;
              try {
                const module = await downloadDependency(
                  depName,
                  subDepVersion,
                  p
                );

                if (module) {
                  manager.addModule(module);
                  const tModule = manager.addTranspiledModule(module, '');

                  tModule.initiators.add(currentTModule);
                  currentTModule.dependencies.add(tModule);

                  callback(null, module.code);
                  return null;
                }
              } catch (er) {
                // Let it throw the error
              }
            }

            return callback(e);
          }
        },
      },
      (err, resolvedPath) => {
        if (err) {
          return reject(err);
        }

        return res(resolvedPath);
      }
    );
  });
}

type DependencyVersionResult =
  | {
      version: string;
      packageJSONPath: string;
    }
  | {
      version: string;
      packageJSONPath: null;
    }
  | {
      version: string;
      name: string | null;
      packageJSONPath: null;
    };

async function getDependencyVersion(
  currentTModule: TranspiledModule,
  manager: Manager,
  defaultExtensions: string[] = ['js', 'jsx', 'json', 'mjs'],
  dependencyName: string
): Promise<DependencyVersionResult | null> {
  const { manifest } = manager;

  try {
    const foundPackageJSONPath = await resolvePath(
      pathUtils.join(dependencyName, 'package.json'),
      currentTModule,
      manager,
      defaultExtensions
    );

    // If the dependency is in the root we get it from the manifest, as the manifest
    // contains all the versions that we really wanted to resolve in the first place.
    // An example of this is csb.dev packages, the package.json version doesn't say the
    // actual version, but the semver it relates to. In this case we really want to have
    // the actual url
    if (
      foundPackageJSONPath ===
      pathUtils.join('/node_modules', dependencyName, 'package.json')
    ) {
      const rootDependency = manifest.dependencies.find(
        dep => dep.name === dependencyName
      );
      if (rootDependency) {
        return {
          packageJSONPath: foundPackageJSONPath,
          version: rootDependency.version,
        };
      }
    }

    const packageJSON =
      manager.transpiledModules[foundPackageJSONPath] &&
      manager.transpiledModules[foundPackageJSONPath].module.code;
    const { version } = JSON.parse(packageJSON);

    const savedDepDep = manifest.dependencyDependencies[dependencyName];

    if (
      savedDepDep &&
      savedDepDep.resolved === version &&
      savedDepDep.semver.startsWith('https://')
    ) {
      return {
        packageJSONPath: foundPackageJSONPath,
        version: savedDepDep.semver,
      };
    }

    if (packageJSON !== '//empty.js') {
      return { packageJSONPath: foundPackageJSONPath, version };
    }
  } catch (e) {
    /* do nothing */
  }

  let version = null;

  if (manifest.dependencyDependencies[dependencyName]) {
    if (
      manifest.dependencyDependencies[dependencyName].semver.startsWith(
        'https://'
      )
    ) {
      version = manifest.dependencyDependencies[dependencyName].semver;
    } else {
      version = manifest.dependencyDependencies[dependencyName].resolved;
    }
  } else {
    const dep = manifest.dependencies.find(m => m.name === dependencyName);

    if (dep) {
      // eslint-disable-next-line
      version = dep.version;
    }
  }

  if (version) {
    return { packageJSONPath: null, version };
  }

  return null;
}

export default async function fetchModule(
  path: string,
  currentTModule: TranspiledModule,
  manager: Manager,
  defaultExtensions: Array<string> = ['js', 'jsx', 'json', 'mjs']
): Promise<Module> {
  const currentPath = currentTModule.module.path;
  // Get the last part of the path as dependency name for paths like
  // instantsearch.js/node_modules/lodash/sum.js
  // In this case we want to get the lodash dependency info
  const dependencyName = getDependencyName(
    path.replace(/.*\/node_modules\//, '')
  );

  const versionInfo = await getDependencyVersion(
    currentTModule,
    manager,
    defaultExtensions,
    dependencyName
  );

  if (versionInfo === null) {
    throw new DependencyNotFoundError(path);
  }

  const { packageJSONPath, version } = versionInfo;

  let meta: Meta;
  let normalizeFunction: typeof normalize;

  try {
    if (dependencyName === 'd3-interpolate') {
      // A folder is missing on d3-interpolate on jsdelivr, this way we force unpkg.com.
      // Keep track: https://github.com/jsdelivr/jsdelivr/issues/18223
      throw new Error("Doesn't work on jsdelivr yet");
    }

    normalizeFunction = getFetchProtocol(version).normalizeMeta;
    meta = await getMeta(dependencyName, packageJSONPath, version);
  } catch (e) {
    // Use fallback
    meta = await getMeta(dependencyName, packageJSONPath, version, true);
    normalizeFunction = getFetchProtocol(version, true).normalizeMeta;
  }

  const rootPath = packageJSONPath
    ? pathUtils.dirname(packageJSONPath)
    : pathUtils.join('/node_modules', dependencyName);
  const normalizedCacheKey = dependencyName + rootPath;
  const normalizedMeta =
    normalizedMetas[normalizedCacheKey] ||
    normalizeFunction(meta.files, {}, rootPath);
  normalizedMetas[normalizedCacheKey] = normalizedMeta;
  combinedMetas = { ...combinedMetas, ...normalizedMeta };

  const foundPath = await resolvePath(
    path,
    currentTModule,
    manager,
    defaultExtensions,
    normalizedMeta
  );

  if (foundPath === '//empty.js') {
    // Mark the path of the module as the real module, because during evaluation
    // we don't have meta to find which modules are browser modules and we still
    // need to return an empty module for browser modules.
    const isDependency = /^(\w|@\w|@-)/.test(path);

    return {
      path: isDependency
        ? pathUtils.join('/node_modules', path)
        : pathUtils.join(currentPath, path),
      code: 'module.exports = {};',
      requires: [],
      stubbed: true,
    };
  }

  return downloadDependency(dependencyName, version, foundPath);
}
