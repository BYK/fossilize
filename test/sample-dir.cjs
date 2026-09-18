const sea = require('node:sea');
const read = (key) => new TextDecoder().decode(sea.getRawAsset(key)).trim();
console.log(`${read('data/a.txt')} ${read('data/nested/b.txt')}`);
