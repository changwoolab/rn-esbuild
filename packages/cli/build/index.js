const esbuild = require('esbuild');
const { getEsbuildBaseOptions } = require('../../../shared');

const buildOptions = getEsbuildBaseOptions(__dirname, {
  banner: {
    js: '#!/bin/node',
  },
});

esbuild.build(buildOptions).catch((error) => {
  console.error(error);
  process.exit(-1);
});