'use strict';

const { BrowserWindow } = require('electron');

function createNativeTestWindow(options) {
  // macOS runners can have short work areas. Keep the fixture's requested native
  // content size so layout, capture and sendInputEvent use the same coordinates.
  return new BrowserWindow({ ...options, enableLargerThanScreen: true });
}

module.exports = { createNativeTestWindow };
