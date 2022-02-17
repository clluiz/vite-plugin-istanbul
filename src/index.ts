import type { SourceMap } from 'rollup';
import { Plugin, TransformResult, createLogger } from 'vite';
import { createInstrumenter } from 'istanbul-lib-instrument';
import TestExclude from 'test-exclude';
import { yellow } from 'chalk';

// Required for typing to work in configureServer()
declare global {
  var __coverage__: any;
}

interface IstanbulPluginOptions {
  include?: string|string[];
  exclude?: string|string[];
  extension?: string|string[];
  requireEnv?: boolean;
  cypress?: boolean;
  checkProd?: boolean;
  cwd?: string;
  forceBuildInstrument?: boolean;
}

// Custom extensions to include .vue files
const DEFAULT_EXTENSION = ['.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.vue'];
const COVERAGE_PUBLIC_PATH = '/__coverage__';
const PLUGIN_NAME = 'vite:istanbul';
const MODULE_PREFIX = '/@modules/';
const NULL_STRING = '\0';

function sanitizeSourceMap(sourceMap: SourceMap): SourceMap {
  // JSON parse/stringify trick required for istanbul to accept the SourceMap
  return JSON.parse(JSON.stringify(sourceMap));
}

export = function istanbulPlugin(opts: IstanbulPluginOptions = {}): Plugin {
  // Only instrument when we want to, as we only want instrumentation in test
  // By default the plugin is always on
  const requireEnv = opts?.requireEnv ?? false;
  const checkProd = opts?.checkProd ?? true;
  const forceBuildInstrument = opts?.forceBuildInstrument ?? false
  const logger = createLogger('warn', { prefix: 'vite-plugin-istanbul' });
  const exclude = new TestExclude({
    cwd: opts.cwd ?? process.cwd(),
    include: opts.include,
    exclude: opts.exclude,
    extension: opts.extension ?? DEFAULT_EXTENSION,
    excludeNodeModules: true,
  });
  const instrumenter = createInstrumenter({
    preserveComments: true,
    produceSourceMap: true,
    autoWrap: true,
    esModules: true,
  });

  // Lazy check the active status of the plugin
  // as this gets fed after config is fully resolved
  let enabled = true;

  return {
    name: PLUGIN_NAME,
    apply: forceBuildInstrument ? 'build' : 'serve',
    // istanbul only knows how to instrument JavaScript,
    // this allows us to wait until the whole code is JavaScript to
    // instrument and sourcemap
    enforce: 'post',
    config(config) {
      if (config.build?.sourcemap != true) {
        logger.warn(`${PLUGIN_NAME}> ${yellow('Sourcemaps not enabled and will be automatically enabled for code coverage to be accurate.')}`);

        // Enforce sourcemapping,
        config.build = config.build || {};
        config.build.sourcemap = true;
      }
    },
    configResolved(config) {
      // We need to check if the plugin should enable after all configuration is resolved
      // As config can be modified by other plugins and from .env variables
      const { isProduction } = config;
      const { VITE_CYPRESS_COVERAGE, VITE_COVERAGE } = config.env;
      const env = (opts.cypress ? VITE_CYPRESS_COVERAGE : VITE_COVERAGE)?.toLowerCase();

      if ((checkProd && isProduction && !forceBuildInstrument) ||
        (!requireEnv && env === 'false') ||
        (requireEnv && env !== 'true')) {
        enabled = false;
      }
    },
    configureServer({ middlewares }) {
      if (!enabled) {
        return;
      }

      // Returns the current code coverage in the global scope
      middlewares.use((req, res, next) => {
        if (req.url !== COVERAGE_PUBLIC_PATH) {
          return next();
        }

        const coverage = (global.__coverage__) ?? null;
        let data: string;

        try {
          data = JSON.stringify(coverage, null, 4);
        } catch (ex) {
          return next(ex);
        }

        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 200;
        res.end(data);
      });
    },
    transform(srcCode, id) {
      if (!enabled || id.startsWith(MODULE_PREFIX) || id.startsWith(NULL_STRING)) {
        // do not transform if this is a dep
        // do not transform if plugin is not enabled
        return;
      }

      if (exclude.shouldInstrument(id)) {
        const sourceMap = sanitizeSourceMap(this.getCombinedSourcemap());
        const code = instrumenter.instrumentSync(srcCode, id, sourceMap);
        const map = instrumenter.lastSourceMap();

        // Required to cast to correct mapping value
        return { code, map } as TransformResult;
      }
    },
  };
}
