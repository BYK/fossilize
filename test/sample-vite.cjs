const sea = require('node:sea');
const manifest = JSON.parse(new TextDecoder().decode(sea.getRawAsset('manifest.json')));
const entry = manifest['index.html'];
const keys = ['index.html', entry.file, ...entry.css, ...entry.assets];
console.log(keys.filter((key) => sea.getRawAsset(key).byteLength > 0).join(' '));
