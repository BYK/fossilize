const sea = require('node:sea');
console.log(new TextDecoder().decode(sea.getRawAsset('asset.txt')));
