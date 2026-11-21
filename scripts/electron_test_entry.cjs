'use strict';

const { app } = require('electron');

try {
  const [, , fixture, profile] = process.argv;
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  // Preserve the command-line shape of launching the fixture directly.
  process.argv.splice(1, process.argv.length - 1, fixture);
  require(fixture);
} catch (error) {
  console.error(error);
  app.exit(1);
}
